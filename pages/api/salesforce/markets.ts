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

    // Remove "Created Date + Time" from row groupings — keep only Market
    // This reduces grouping combos from ~15K to ~43
    if (Array.isArray(baseMetadata.groupingsDown)) {
      baseMetadata.groupingsDown = baseMetadata.groupingsDown.filter(
        (g: any) => {
          const col = g.name || g.column || '';
          // Keep Market, remove date groupings
          return !col.includes('CREATED_DATE') && !col.includes('CreatedDate') && !col.includes('Created_Date');
        }
      );
    }

    // Determine years to query
    const now = new Date();
    const latestYear = now.getFullYear();
    const priorYear = latestYear - 1;

    // Find the date filter column name from report filters
    let dateFilterColumn = 'CREATED_DATE';
    if (Array.isArray(baseMetadata.reportFilters)) {
      for (const f of baseMetadata.reportFilters) {
        if (f && typeof f.column === 'string' &&
            (f.column.includes('CREATED_DATE') || f.column.includes('CreatedDate') || f.column.includes('Sales_Date') || f.column.includes('CloseDate'))) {
          dateFilterColumn = f.column;
          break;
        }
      }
    }

    // Helper: run report for a specific year range
    async function runForYear(year: number): Promise<MarketYearData[]> {
      const meta = JSON.parse(JSON.stringify(baseMetadata));

      // Set date filters to constrain to this year
      // Through current date for latest year, full year for prior
      const startDate = `${year}-01-01T00:00:00Z`;
      let endDate: string;
      if (year === latestYear) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 2);
        endDate = tomorrow.toISOString().replace(/\.\d{3}Z$/, 'Z');
      } else {
        endDate = `${year}-12-31T23:59:59Z`;
      }

      // Replace existing date filters with our year-bounded ones
      meta.reportFilters = [
        {
          column: dateFilterColumn,
          operator: 'greaterOrEqual',
          value: startDate
        },
        {
          column: dateFilterColumn,
          operator: 'lessOrEqual',
          value: endDate
        }
      ];

      const runUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}?includeDetails=false`;
      const runResp = await fetch(runUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store'
        },
        body: JSON.stringify({ reportMetadata: meta })
      });

      if (!runResp.ok) {
        const text = await runResp.text();
        console.error(`Markets report error for year ${year}: ${text}`);
        return [];
      }

      const reportData = await runResp.json();

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

    return res.status(200).json({
      markets,
      marketData: allData,
      latestYear,
      priorYear,
      latestCount: latestData.length,
      priorCount: priorData.length
    });
  } catch (err: any) {
    console.error('Markets Salesforce API error:', err);
    return res.status(500).json({
      error: 'Unexpected Salesforce markets API error',
      details: err.message || String(err)
    });
  }
}
