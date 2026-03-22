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

type MarketYearData = {
  market: string;
  year: number;
  amount: number;
  count: number;
};

/**
 * This endpoint runs the Salesforce markets report TWICE — once per year —
 * each time with Market as the ONLY row grouping. This avoids the 2K grouping
 * limit that occurs with Date × Market cross-grouping (~15K+ combos).
 *
 * Each year-run returns ~43 market rows (well under the 2K cap).
 * The frontend can then do YoY comparisons directly.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const debug = req.query.debug === 'true';

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

    // 1) Describe to get base metadata
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
    const baseMetadata = describeData.reportMetadata;

    // If debug mode, return raw metadata so we can see groupings and filters
    if (debug) {
      return res.status(200).json({
        _debug: true,
        groupingsDown: baseMetadata.groupingsDown,
        reportFilters: baseMetadata.reportFilters,
        standardDateFilter: baseMetadata.standardDateFilter,
        reportFormat: baseMetadata.reportFormat,
        aggregates: baseMetadata.aggregates
      });
    }

    const originalGroupingsDown = JSON.parse(JSON.stringify(baseMetadata.groupingsDown || []));
    const originalFilters = JSON.parse(JSON.stringify(baseMetadata.reportFilters || []));

    // Log groupingsDown for debugging, then keep ONLY the Market grouping.
    // The report has 2 row groupings: Created Date + Time (index 0) and Market (index 1).
    // We remove the date grouping to avoid the 2K grouping limit (date × market = ~15K combos).
    // Market is always the LAST grouping we added, so take the last element.
    if (Array.isArray(baseMetadata.groupingsDown) && baseMetadata.groupingsDown.length > 1) {
      // Log all grouping names for debugging
      console.log('groupingsDown:', JSON.stringify(baseMetadata.groupingsDown.map((g: any) => g.name)));
      // Keep only the last grouping (Market) — the first one is Created Date + Time
      baseMetadata.groupingsDown = [baseMetadata.groupingsDown[baseMetadata.groupingsDown.length - 1]];
    }

    // Determine years to query
    const now = new Date();
    const latestYear = now.getFullYear();
    const priorYear = latestYear - 1;

    // Find date filter columns from existing report filters
    // We'll modify their values to scope to a single year, while keeping all other filters intact
    const dateFilterIndices: number[] = [];
    if (Array.isArray(baseMetadata.reportFilters)) {
      for (let i = 0; i < baseMetadata.reportFilters.length; i++) {
        const f = baseMetadata.reportFilters[i];
        if (f && typeof f.column === 'string') {
          const colLower = f.column.toLowerCase();
          if (colLower.includes('date') || colLower.includes('created') || colLower.includes('close')) {
            dateFilterIndices.push(i);
          }
        }
      }
    }

    // Helper: run report for a specific year range
    async function runForYear(year: number): Promise<MarketYearData[]> {
      const meta = JSON.parse(JSON.stringify(baseMetadata));

      // Compute date boundaries for this year
      const startDate = `${year}-01-01T00:00:00Z`;
      let endDate: string;
      if (year === latestYear) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 2);
        endDate = tomorrow.toISOString().replace(/\.\d{3}Z$/, 'Z');
      } else {
        endDate = `${year}-12-31T23:59:59Z`;
      }

      // Modify existing date filters to scope to this year (keep all other filters!)
      if (dateFilterIndices.length > 0 && Array.isArray(meta.reportFilters)) {
        for (const idx of dateFilterIndices) {
          const f = meta.reportFilters[idx];
          if (!f) continue;
          if (f.operator === 'greaterOrEqual' || f.operator === 'greaterThan' || f.operator === 'after') {
            f.value = startDate;
          } else if (f.operator === 'lessOrEqual' || f.operator === 'lessThan' || f.operator === 'before') {
            f.value = endDate;
          }
        }
      } else {
        // Fallback: use the standard date filter if we couldn't find existing ones
        // Use the Salesforce standard filter instead of reportFilters
        meta.standardDateFilter = {
          column: 'CREATED_DATE',
          durationValue: 'CUSTOM',
          startDate: `${year}-01-01`,
          endDate: year === latestYear
            ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() + 1).padStart(2, '0')}`
            : `${year}-12-31`
        };
      }

      const runUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}?includeDetails=false`;
      const runBody = { reportMetadata: meta };
      const runResp = await fetch(runUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store'
        },
        body: JSON.stringify(runBody)
      });

      if (!runResp.ok) {
        const text = await runResp.text();
        console.error(`Markets report error for year ${year}: ${text}`);
        // Store error for debug
        (runForYear as any)._lastError = { year, status: runResp.status, text };
        return [];
      }

      const reportData = await runResp.json();

      // Store debug info
      (runForYear as any)._lastRun = {
        year,
        sentMetadata: meta,
        groupingsDownCount: reportData.groupingsDown?.groupings?.length ?? 'N/A',
        factMapKeys: Object.keys(reportData.factMap || {}),
        aggregateKeys: Object.keys(reportData.reportExtendedMetadata?.aggregateColumnInfo || {}),
        sampleGroupings: (reportData.groupingsDown?.groupings || []).slice(0, 5).map((g: any) => ({ key: g.key, label: g.label }))
      };

      // Parse single-level groupings: Market → aggregates
      const groupings = reportData.groupingsDown?.groupings || [];
      const factMap = reportData.factMap || {};

      // Figure out aggregate indices
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

      const results: MarketYearData[] = [];

      for (const group of groupings) {
        const market = String(group.label || 'Unknown').trim();
        if (!market) continue;

        const factKey = `${group.key}!T`;
        const fact = factMap[factKey];

        let amount = 0;
        let count = 0;

        if (fact && fact.aggregates) {
          if (amountAggIdx >= 0 && fact.aggregates[amountAggIdx]) {
            amount = parseFloat(fact.aggregates[amountAggIdx].value || '0');
          }
          if (countAggIdx >= 0 && fact.aggregates[countAggIdx]) {
            count = parseInt(fact.aggregates[countAggIdx].value || '0', 10);
          }
        }

        results.push({
          market,
          year,
          amount: Math.round(amount * 100) / 100,
          count
        });
      }

      return results;
    }

    // 2) Run for both years in parallel
    const [latestData, priorData] = await Promise.all([
      runForYear(latestYear),
      runForYear(priorYear)
    ]);

    // 3) Combine results
    const allData = [...priorData, ...latestData];
    const markets = [...new Set(allData.map(r => r.market))].sort();

    const responsePayload: any = {
      markets,
      marketData: allData,
      latestYear,
      priorYear,
      latestCount: latestData.length,
      priorCount: priorData.length
    };

    // Always include debug info temporarily to diagnose the empty results
    responsePayload._debug = {
      lastRun: (runForYear as any)._lastRun || null,
      lastError: (runForYear as any)._lastError || null,
      dateFilterIndices,
      originalGroupingsDown,
      originalFilters,
      reportFiltersCount: baseMetadata.reportFilters?.length ?? 0
    };

    return res.status(200).json(responsePayload);
  } catch (err: any) {
    console.error('Markets Salesforce API error:', err);
    return res.status(500).json({
      error: 'Unexpected Salesforce markets API error',
      details: err.message || String(err)
    });
  }
}
