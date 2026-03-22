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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Salesforce token error (${resp.status}): ${text}`);
  }

  const json = (await resp.json()) as SalesforceAuthResponse;
  return json.access_token;
}

type MarketYearData = {
  market: string;
  year: number;
  amount: number;
  count: number;
};

/**
 * Markets API — runs the Salesforce report in MONTHLY chunks to stay under
 * the 2K grouping row limit (43 markets × 31 days ≈ 1,300 combos/month).
 *
 * Key insight: we do NOT modify groupingsDown at all, avoiding the chart
 * reference error. We only override standardDateFilter to narrow the window.
 * Then we parse the 2-level nested groupings (Date → Market) and aggregate
 * by market across all months.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const debugLog: any = {};

  try {
    const {
      SALESFORCE_INSTANCE_URL,
      SALESFORCE_REPORT_ID_MARKETS: REPORT_ID,
      SALESFORCE_API_VERSION
    } = process.env;

    if (!SALESFORCE_INSTANCE_URL || !REPORT_ID) {
      return res.status(500).json({ error: 'Salesforce instance URL or markets report ID not configured' });
    }

    const apiVersion = SALESFORCE_API_VERSION || 'v62.0';
    const accessToken = await getAccessToken();

    // Determine date ranges
    const now = new Date();
    const latestYear = now.getFullYear();
    const priorYear = latestYear - 1;
    const currentMonth = now.getMonth(); // 0-indexed

    // Describe report to get the date column for standardDateFilter
    const describeUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}/describe`;
    const describeResp = await fetch(describeUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!describeResp.ok) {
      const text = await describeResp.text();
      return res.status(502).json({ error: 'Error describing report', details: text });
    }

    const describeData = await describeResp.json();
    const dateColumn = describeData.reportMetadata?.standardDateFilter?.column || 'CLOSE_DATE';
    debugLog.dateColumn = dateColumn;
    debugLog.reportFormat = describeData.reportMetadata?.reportFormat;
    debugLog.groupingsDown = describeData.reportMetadata?.groupingsDown;

    // Build month ranges for a given year (up to currentMonth+1 for latestYear)
    function getMonthRanges(year: number): Array<{ start: string; end: string; label: string }> {
      const maxMonth = year === latestYear ? currentMonth : 11;
      const ranges = [];
      for (let m = 0; m <= maxMonth; m++) {
        const start = `${year}-${String(m + 1).padStart(2, '0')}-01`;
        // End of month: use first day of next month minus 1
        const endDate = new Date(year, m + 1, 0); // last day of month m
        let end: string;
        if (year === latestYear && m === currentMonth) {
          // For current month, use tomorrow as end date
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          end = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
        } else {
          end = `${year}-${String(m + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
        }
        ranges.push({ start, end, label: `${year}-${String(m + 1).padStart(2, '0')}` });
      }
      return ranges;
    }

    // Run report for a single month window — NO metadata overrides except standardDateFilter
    async function runMonth(startDate: string, endDate: string): Promise<{
      markets: Map<string, { amount: number; count: number }>;
      error?: any;
    }> {
      const meta = {
        standardDateFilter: {
          column: dateColumn,
          durationValue: 'CUSTOM',
          startDate,
          endDate
        }
      };

      const runUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}?includeDetails=false`;
      const resp = await fetch(runUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store'
        },
        body: JSON.stringify({ reportMetadata: meta })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return { markets: new Map(), error: { status: resp.status, body: errText.substring(0, 500) } };
      }

      const reportData = await resp.json();

      // Find aggregate indices
      const aggInfo = reportData.reportExtendedMetadata?.aggregateColumnInfo || {};
      const aggKeys = Object.keys(aggInfo);
      let amountIdx = -1;
      let countIdx = -1;
      for (let i = 0; i < aggKeys.length; i++) {
        const info = aggInfo[aggKeys[i]];
        const label = (info?.label || '').toLowerCase();
        const key = aggKeys[i].toLowerCase();
        if (label.includes('amount') || key.includes('amount')) amountIdx = i;
        if (label === 'record count' || key === 'rowcount') countIdx = i;
      }

      const markets = new Map<string, { amount: number; count: number }>();

      // Parse 2-level groupings: Date (level 0) → Market (level 1)
      const dateGroups = reportData.groupingsDown?.groupings || [];
      const factMap = reportData.factMap || {};

      for (const dateGroup of dateGroups) {
        const marketGroups = dateGroup.groupings || [];
        for (const mktGroup of marketGroups) {
          const market = String(mktGroup.label || mktGroup.value || '').trim();
          if (!market || market === '-') continue;

          const factKey = `${dateGroup.key}_${mktGroup.key}!T`;
          const fact = factMap[factKey];

          let amount = 0;
          let count = 0;
          if (fact && fact.aggregates) {
            if (amountIdx >= 0 && fact.aggregates[amountIdx]) {
              amount = parseFloat(fact.aggregates[amountIdx].value || '0');
            }
            if (countIdx >= 0 && fact.aggregates[countIdx]) {
              count = parseInt(fact.aggregates[countIdx].value || '0', 10);
            }
          }

          const existing = markets.get(market) || { amount: 0, count: 0 };
          existing.amount += amount;
          existing.count += count;
          markets.set(market, existing);
        }
      }

      return { markets };
    }

    // Run all months for a year, with parallelism (batch 3 at a time to not overwhelm)
    async function runYear(year: number): Promise<{ data: MarketYearData[]; debug: any }> {
      const months = getMonthRanges(year);
      const yearDebug: any = { year, monthCount: months.length, monthErrors: [] };

      const aggregated = new Map<string, { amount: number; count: number }>();

      // Run in batches of 3 concurrent requests
      const batchSize = 3;
      for (let i = 0; i < months.length; i += batchSize) {
        const batch = months.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(m => runMonth(m.start, m.end))
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.error) {
            yearDebug.monthErrors.push({ month: batch[j].label, error: result.error });
          }
          for (const [market, data] of result.markets) {
            const existing = aggregated.get(market) || { amount: 0, count: 0 };
            existing.amount += data.amount;
            existing.count += data.count;
            aggregated.set(market, existing);
          }
        }
      }

      const data: MarketYearData[] = [];
      for (const [market, agg] of aggregated) {
        if (agg.amount > 0 || agg.count > 0) {
          data.push({
            market,
            year,
            amount: Math.round(agg.amount * 100) / 100,
            count: agg.count
          });
        }
      }

      yearDebug.marketsFound = data.length;
      yearDebug.totalAmount = data.reduce((s, d) => s + d.amount, 0);
      yearDebug.totalCount = data.reduce((s, d) => s + d.count, 0);
      return { data, debug: yearDebug };
    }

    // Run both years in parallel
    const [latestResult, priorResult] = await Promise.all([
      runYear(latestYear),
      runYear(priorYear)
    ]);

    debugLog.latestYearDebug = latestResult.debug;
    debugLog.priorYearDebug = priorResult.debug;

    const allData = [...priorResult.data, ...latestResult.data];
    const markets = [...new Set(allData.map(r => r.market))].sort();

    return res.status(200).json({
      markets,
      marketData: allData,
      latestYear,
      priorYear,
      latestCount: latestResult.data.length,
      priorCount: priorResult.data.length,
      _debug: debugLog
    });
  } catch (err: any) {
    console.error('Markets API error:', err);
    return res.status(500).json({
      error: 'Unexpected markets API error',
      details: err.message || String(err),
      _debug: debugLog
    });
  }
}
