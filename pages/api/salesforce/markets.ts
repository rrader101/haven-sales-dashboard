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
 * Uses the exact same pattern as daily.ts:
 *   1) Describe the report to get full metadata
 *   2) Modify the Sales_Date__c reportFilters to narrow the date window
 *   3) Send the FULL metadata back (chart, groupings, everything untouched)
 *   4) Parse 2-level nested groupings (Date → Market) and aggregate by market
 *
 * This avoids ALL previous errors because we don't change groupingsDown
 * (no chart reference error) and we filter on the correct field (Sales_Date__c,
 * not CLOSE_DATE).
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

    const now = new Date();
    const latestYear = now.getFullYear();
    const priorYear = latestYear - 1;
    const currentMonth = now.getMonth(); // 0-indexed

    // 1) Describe report to get full metadata (same as daily.ts)
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
    const baseMetadata = describeData.reportMetadata;

    debugLog.reportFormat = baseMetadata?.reportFormat;
    debugLog.groupingsDown = baseMetadata?.groupingsDown;
    debugLog.reportFilters = baseMetadata?.reportFilters;

    // Build month ranges
    function getMonthRanges(year: number): Array<{ startISO: string; endISO: string; label: string }> {
      const maxMonth = year === latestYear ? currentMonth : 11;
      const ranges = [];
      for (let m = 0; m <= maxMonth; m++) {
        // Start: first day of month at midnight UTC-5 (matching report's timezone offset)
        const startISO = `${year}-${String(m + 1).padStart(2, '0')}-01T05:00:00Z`;

        // End: last day of month (or tomorrow for current month)
        let endDay: number;
        if (year === latestYear && m === currentMonth) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 2);
          endDay = tomorrow.getDate();
        } else {
          endDay = new Date(year, m + 1, 0).getDate(); // last day of month
        }
        const endMonth = (year === latestYear && m === currentMonth)
          ? now.getMonth() + 1 // could roll over
          : m + 1;
        const endYear = year;
        const endISO = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}T04:00:00Z`;

        ranges.push({ startISO, endISO, label: `${year}-${String(m + 1).padStart(2, '0')}` });
      }
      return ranges;
    }

    // 2) Run report for a single month — send FULL metadata, only modify date filter values
    async function runMonth(startISO: string, endISO: string, label: string): Promise<{
      markets: Map<string, { amount: number; count: number }>;
      debug?: any;
      error?: any;
    }> {
      // Deep clone the full metadata (just like daily.ts sends the full metadata)
      const meta = JSON.parse(JSON.stringify(baseMetadata));

      // Modify the Sales_Date__c filters to narrow to this month
      // (same pattern as daily.ts modifying the upper-bound filter)
      if (Array.isArray(meta.reportFilters)) {
        meta.reportFilters = meta.reportFilters.map((f: any) => {
          if (
            f &&
            typeof f === 'object' &&
            typeof f.column === 'string' &&
            f.column.includes('Sales_Date__c')
          ) {
            if (f.operator === 'greaterOrEqual' || f.operator === 'greaterThan') {
              return { ...f, value: startISO };
            }
            if (f.operator === 'lessOrEqual' || f.operator === 'lessThan') {
              return { ...f, value: endISO };
            }
          }
          return f;
        });
      }

      const monthDebug: any = { label, startISO, endISO };

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

      // Find aggregate indices — use exact key matching to avoid picking up
      // the wrong "amount" aggregate (e.g. mx!AMOUNT instead of s!AMOUNT)
      const aggInfo = reportData.reportExtendedMetadata?.aggregateColumnInfo || {};
      const aggKeys = Object.keys(aggInfo);
      let amountIdx = -1;
      let countIdx = -1;
      for (let i = 0; i < aggKeys.length; i++) {
        const key = aggKeys[i];
        // Exact match: "s!AMOUNT" = Sum of Amount
        if (key === 's!AMOUNT') amountIdx = i;
        // Exact match: "RowCount" = Record Count
        if (key === 'RowCount') countIdx = i;
      }
      // Fallback: if exact keys not found, try label-based (prefer "Sum of")
      if (amountIdx === -1 || countIdx === -1) {
        for (let i = 0; i < aggKeys.length; i++) {
          const info = aggInfo[aggKeys[i]];
          const label = (info?.label || '').toLowerCase();
          if (amountIdx === -1 && label.startsWith('sum of amount')) amountIdx = i;
          if (countIdx === -1 && label === 'record count') countIdx = i;
        }
      }

      const markets = new Map<string, { amount: number; count: number }>();

      // Parse 2-level groupings: Date (level 0) → Market (level 1)
      const dateGroups = reportData.groupingsDown?.groupings || [];
      const factMap = reportData.factMap || {};

      monthDebug.dateGroupsCount = dateGroups.length;
      monthDebug.firstDateGroup = dateGroups[0] ? {
        key: dateGroups[0].key,
        label: dateGroups[0].label,
        subGroupCount: (dateGroups[0].groupings || []).length,
        firstSubGroup: (dateGroups[0].groupings || [])[0]
      } : null;
      monthDebug.factMapKeysSample = Object.keys(factMap).slice(0, 5);
      monthDebug.amountIdx = amountIdx;
      monthDebug.countIdx = countIdx;
      monthDebug.aggColumns = aggKeys.map(k => ({ key: k, label: aggInfo[k]?.label }));

      // Track debug info for fact key resolution
      let factHits = 0;
      let factMisses = 0;
      let firstFactKey = '';
      let firstFactFound = false;

      for (const dateGroup of dateGroups) {
        const marketGroups = dateGroup.groupings || [];
        for (const mktGroup of marketGroups) {
          const market = String(mktGroup.label || mktGroup.value || '').trim();
          if (!market || market === '-') continue;

          // In Salesforce SUMMARY reports with nested groupings, the subgroup key
          // already encodes the full path (e.g. "0_0" = dateGroup 0, mktGroup 0).
          // The factMap key is just "<subGroupKey>!T", NOT "<parentKey>_<subKey>!T".
          const factKey = `${mktGroup.key}!T`;
          const fact = factMap[factKey];

          if (!firstFactKey) {
            firstFactKey = factKey;
            firstFactFound = !!fact;
          }

          let amount = 0;
          let count = 0;
          if (fact && fact.aggregates) {
            factHits++;
            if (amountIdx >= 0 && fact.aggregates[amountIdx]) {
              amount = parseFloat(fact.aggregates[amountIdx].value || '0');
            }
            if (countIdx >= 0 && fact.aggregates[countIdx]) {
              count = parseInt(fact.aggregates[countIdx].value || '0', 10);
            }
          } else {
            factMisses++;
          }

          const existing = markets.get(market) || { amount: 0, count: 0 };
          existing.amount += amount;
          existing.count += count;
          markets.set(market, existing);
        }
      }

      monthDebug.marketsFound = markets.size;
      monthDebug.factHits = factHits;
      monthDebug.factMisses = factMisses;
      monthDebug.firstFactKey = firstFactKey;
      monthDebug.firstFactFound = firstFactFound;
      return { markets, debug: monthDebug };
    }

    // 3) Run all months for a year (batch 3 at a time)
    async function runYear(year: number): Promise<{ data: MarketYearData[]; debug: any }> {
      const months = getMonthRanges(year);
      const yearDebug: any = { year, monthCount: months.length, monthErrors: [], monthDetails: [] };

      const aggregated = new Map<string, { amount: number; count: number }>();

      const batchSize = 3;
      for (let i = 0; i < months.length; i += batchSize) {
        const batch = months.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(m => runMonth(m.startISO, m.endISO, m.label))
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          if (result.error) {
            yearDebug.monthErrors.push({ month: batch[j].label, error: result.error });
          }
          // Only include debug for first month to keep response size manageable
          if (i === 0 && j === 0 && result.debug) {
            yearDebug.firstMonthDebug = result.debug;
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
      yearDebug.totalAmount = Math.round(data.reduce((s, d) => s + d.amount, 0) * 100) / 100;
      yearDebug.totalCount = data.reduce((s, d) => s + d.count, 0);
      yearDebug.sampleMarkets = data.slice(0, 5).map(d => ({ market: d.market, amount: d.amount, count: d.count }));
      yearDebug.aggregatedMapSize = aggregated.size;
      return { data, debug: yearDebug };
    }

    // 4) Run both years in parallel
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
