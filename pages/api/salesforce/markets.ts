import type { NextApiRequest, NextApiResponse } from 'next';

type SalesforceAuthResponse = {
  access_token: string;
  instance_url: string;
  issued_at: string;
  signature: string;
  token_type: string;
};

async function getAccessToken(): Promise<string> {
  const {
    SALESFORCE_CLIENT_ID,
    SALESFORCE_CLIENT_SECRET,
    SALESFORCE_REFRESH_TOKEN,
    SALESFORCE_LOGIN_URL
  } = process.env;

  if (!SALESFORCE_CLIENT_ID || !SALESFORCE_CLIENT_SECRET || !SALESFORCE_REFRESH_TOKEN) {
    throw new Error('Salesforce env vars are not fully configured');
  }

  const loginUrl = SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: SALESFORCE_CLIENT_ID,
    client_secret: SALESFORCE_CLIENT_SECRET,
    refresh_token: SALESFORCE_REFRESH_TOKEN
  });

  const resp = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Salesforce token error (${resp.status}): ${text}`);
  }

  const json = (await resp.json()) as SalesforceAuthResponse;
  return json.access_token;
}

// Calculate ISO week number and year from a Date
function getISOWeek(dt: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

// Calculate the Monday of a given ISO week
function mondayOfWeek(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4.getTime() + ((week - 1) * 7 - (dayOfWeek - 1)) * 86400000);
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  return `${monday.getUTCFullYear()}-${mm}-${dd}`;
}

type MarketWeekData = {
  market: string;
  year: number;
  week: number;
  monday: string;
  amount: number;
  count: number;
};

/**
 * This endpoint uses a Salesforce report that groups by:
 *   Level 0: Created Date + Time (date)
 *   Level 1: Market (text)
 *
 * It reads the nested groupings (no detail rows needed) to get
 * aggregate Amount and Record Count per market per day, then
 * rolls those up into ISO weeks.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      SALESFORCE_INSTANCE_URL,
      SALESFORCE_REPORT_ID_MARKETS: REPORT_ID,
      SALESFORCE_API_VERSION
    } = process.env;

    if (!SALESFORCE_INSTANCE_URL || !REPORT_ID) {
      return res.status(500).json({ error: 'Salesforce instance URL or markets report ID not configured' });
    }

    const apiVersion = SALESFORCE_API_VERSION || 'v59.0';
    const accessToken = await getAccessToken();

    // 1) Describe to get metadata
    const describeUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}/describe`;
    const describeResp = await fetch(describeUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!describeResp.ok) {
      const text = await describeResp.text();
      return res.status(502).json({ error: 'Error describing markets report', details: text });
    }

    const describeData = await describeResp.json();
    const metadata = describeData.reportMetadata;

    // Adjust upper-bound date filter
    if (Array.isArray(metadata.reportFilters)) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 2);
      tomorrow.setHours(23, 59, 59, 0);
      const upperBound = tomorrow.toISOString().replace(/\.\d{3}Z$/, 'Z');

      metadata.reportFilters = metadata.reportFilters.map((f: any) => {
        if (
          f &&
          typeof f === 'object' &&
          f.operator === 'lessOrEqual' &&
          typeof f.column === 'string' &&
          (f.column.includes('Sales_Date__c') || f.column.includes('CloseDate'))
        ) {
          return { ...f, value: upperBound };
        }
        return f;
      });
    }

    // 2) Run report WITHOUT detail rows — we only need grouping aggregates
    const runUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}?includeDetails=false`;
    const runResp = await fetch(runUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store'
      },
      body: JSON.stringify({ reportMetadata: metadata })
    });

    if (runResp.status === 401) {
      return res.status(401).json({ error: 'Salesforce session invalid or expired' });
    }
    if (!runResp.ok) {
      const text = await runResp.text();
      return res.status(502).json({ error: 'Error running markets report', details: text });
    }

    const reportData = await runResp.json();

    // 3) Parse nested groupings: Date → Market → aggregates
    // The report has two row grouping levels:
    //   groupingsDown.groupings[i] = date groups (level 0)
    //   groupingsDown.groupings[i].groupings[j] = market groups (level 1)
    //
    // factMap keys for level-1 groups: "{dateKey}_{marketKey}!T"
    // Each factMap entry has .aggregates[] with [sumAmount, recordCount, ...]

    const groupingsDown = reportData.groupingsDown?.groupings || [];
    const factMap = reportData.factMap || {};

    // Figure out which aggregate indices are Amount (sum) and Record Count
    const aggInfo = reportData.reportExtendedMetadata?.aggregateColumnInfo || {};
    const aggKeys = Object.keys(aggInfo);

    let amountAggIdx = -1;
    let countAggIdx = -1;

    for (let i = 0; i < aggKeys.length; i++) {
      const info = aggInfo[aggKeys[i]];
      if (info?.label === 'Sum of Amount' || info?.label === 'Sum of  Amount' || aggKeys[i] === 's!Amount') {
        amountAggIdx = i;
      }
      if (info?.label === 'Record Count' || aggKeys[i] === 'RowCount') {
        countAggIdx = i;
      }
    }

    // Aggregate: key = "market|year|week" -> { amount, count }
    const agg: Record<string, { amount: number; count: number }> = {};
    // Also track per-day data for more granular use
    const dailyData: Array<{ market: string; date: string; amount: number; count: number }> = [];

    for (let di = 0; di < groupingsDown.length; di++) {
      const dateGroup = groupingsDown[di];
      const dateLabel = dateGroup.label || ''; // e.g. "3/21/2026"

      // Parse date
      const dateParts = dateLabel.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!dateParts) continue;

      const dt = new Date(
        parseInt(dateParts[3]),
        parseInt(dateParts[1]) - 1,
        parseInt(dateParts[2])
      );
      const { year, week } = getISOWeek(dt);
      const dateStr = `${dateParts[3]}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`;

      // Level 1: Market sub-groups
      const marketGroups = dateGroup.groupings || [];

      for (let mi = 0; mi < marketGroups.length; mi++) {
        const marketGroup = marketGroups[mi];
        const market = String(marketGroup.label || 'Unknown').trim();
        if (!market) continue;

        // Get aggregates from factMap
        const factKey = `${dateGroup.key}_${marketGroup.key}!T`;
        const fact = factMap[factKey];

        let amount = 0;
        let count = 0;

        if (fact && fact.aggregates) {
          if (amountAggIdx >= 0 && fact.aggregates[amountAggIdx]) {
            amount = parseFloat(fact.aggregates[amountAggIdx].value || '0');
          }
          if (countAggIdx >= 0 && fact.aggregates[countAggIdx]) {
            count = parseInt(fact.aggregates[countAggIdx].value || '0', 10);
          } else {
            // Fallback: try to find record count
            for (const a of fact.aggregates) {
              if (a && a.label === 'Record Count') {
                count = parseInt(a.value || '0', 10);
                break;
              }
            }
          }
        }

        // Daily granularity
        dailyData.push({ market, date: dateStr, amount, count });

        // Weekly aggregation
        const aggKey = `${market}|${year}|${week}`;
        if (!agg[aggKey]) {
          agg[aggKey] = { amount: 0, count: 0 };
        }
        agg[aggKey].amount += amount;
        agg[aggKey].count += count;
      }
    }

    // Convert weekly aggregation to array
    const weeklyResults: MarketWeekData[] = [];
    for (const key in agg) {
      const [market, yearStr, weekStr] = key.split('|');
      const year = parseInt(yearStr);
      const week = parseInt(weekStr);
      weeklyResults.push({
        market,
        year,
        week,
        monday: mondayOfWeek(year, week),
        amount: Math.round(agg[key].amount * 100) / 100,
        count: agg[key].count
      });
    }

    // Sort by year, week, market
    weeklyResults.sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      if (a.week !== b.week) return a.week - b.week;
      return a.market.localeCompare(b.market);
    });

    // Sort daily data
    dailyData.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.market.localeCompare(b.market);
    });

    // Unique markets
    const markets = [...new Set(weeklyResults.map(r => r.market))].sort();

    return res.status(200).json({
      markets,
      weeklyData: weeklyResults,
      dailyData,
      totalWeeklyRows: weeklyResults.length,
      totalDailyRows: dailyData.length,
      reportHasMoreData: reportData.allData === false
    });
  } catch (err: any) {
    console.error('Markets Salesforce API error:', err);
    return res.status(500).json({
      error: 'Unexpected Salesforce markets API error',
      details: err.message || String(err)
    });
  }
}
