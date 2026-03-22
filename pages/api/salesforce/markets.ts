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
 * Markets API — runs the Salesforce "Deals by Market by Day" report twice
 * (once per year) with Market as the ONLY row grouping, using standardDateFilter
 * for date scoping. This avoids both the 2K grouping limit and the complexity
 * of manipulating reportFilters.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const debugMode = req.query.debug === 'true';
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

    const apiVersion = SALESFORCE_API_VERSION || 'v59.0';
    const accessToken = await getAccessToken();

    // 1) Describe the report to get its metadata
    const describeUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}/describe`;
    const describeResp = await fetch(describeUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!describeResp.ok) {
      const text = await describeResp.text();
      return res.status(502).json({ error: 'Error describing markets report', status: describeResp.status, details: text });
    }

    const describeData = await describeResp.json();
    const baseMetadata = describeData.reportMetadata;

    // Capture original metadata for debug
    debugLog.originalGroupingsDown = JSON.parse(JSON.stringify(baseMetadata.groupingsDown || []));
    debugLog.originalReportFilters = JSON.parse(JSON.stringify(baseMetadata.reportFilters || []));
    debugLog.originalStandardDateFilter = JSON.parse(JSON.stringify(baseMetadata.standardDateFilter || {}));
    debugLog.reportFormat = baseMetadata.reportFormat;

    // If debug-only mode, return raw metadata and stop
    if (debugMode) {
      return res.status(200).json({ _debug: true, ...debugLog });
    }

    // 2) Modify groupings: keep ONLY the Market grouping
    // The report has 2 row groupings: [Created Date+Time, Market]
    // Market was added last, so it's the last element.
    // We remove Date to avoid the 2K grouping limit (date × market = ~15K+ combos).
    if (Array.isArray(baseMetadata.groupingsDown) && baseMetadata.groupingsDown.length > 1) {
      const kept = baseMetadata.groupingsDown[baseMetadata.groupingsDown.length - 1];
      debugLog.keptGrouping = kept;
      baseMetadata.groupingsDown = [kept];
    } else if (Array.isArray(baseMetadata.groupingsDown) && baseMetadata.groupingsDown.length === 1) {
      debugLog.keptGrouping = baseMetadata.groupingsDown[0];
    } else {
      debugLog.keptGrouping = null;
    }

    // Determine the date column for standardDateFilter
    // The report's standardDateFilter uses CLOSE_DATE, but the actual date field
    // used in groupings and filters is Opportunity.Sales_Date__c.
    // Use the standardDateFilter column (CLOSE_DATE) since that's what Salesforce expects
    // for the standardDateFilter mechanism.
    const dateColumn = baseMetadata.standardDateFilter?.column || 'CLOSE_DATE';
    debugLog.dateColumn = dateColumn;

    // Determine years
    const now = new Date();
    const latestYear = now.getFullYear();
    const priorYear = latestYear - 1;

    // 3) Run the report for a specific year
    async function runForYear(year: number): Promise<{ data: MarketYearData[]; debug: any }> {
      // Build a CLEAN metadata object with only the fields Salesforce accepts
      // for the Analytics Report Run POST. Sending unknown properties from describe
      // causes JSON_PARSER_ERROR.
      const startDate = `${year}-01-01`;
      let endDate: string;
      if (year === latestYear) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else {
        endDate = `${year}-12-31`;
      }

      const meta: any = {
        // Only Market grouping (date grouping removed)
        groupingsDown: JSON.parse(JSON.stringify(baseMetadata.groupingsDown)),
        // Keep all existing filters untouched
        reportFilters: JSON.parse(JSON.stringify(baseMetadata.reportFilters || [])),
        // Use standardDateFilter to scope to this year
        standardDateFilter: {
          column: dateColumn,
          durationValue: 'CUSTOM',
          startDate,
          endDate
        },
        // Preserve report format and aggregates
        reportFormat: baseMetadata.reportFormat,
        aggregates: JSON.parse(JSON.stringify(baseMetadata.aggregates || [])),
      };

      // Copy other known-valid fields if they exist
      if (baseMetadata.scope) meta.scope = baseMetadata.scope;
      if (baseMetadata.crossFilters) meta.crossFilters = JSON.parse(JSON.stringify(baseMetadata.crossFilters));
      if (baseMetadata.historicalSnapshotDates) meta.historicalSnapshotDates = baseMetadata.historicalSnapshotDates;
      if (baseMetadata.reportBooleanFilter) meta.reportBooleanFilter = baseMetadata.reportBooleanFilter;
      if (baseMetadata.reportType) meta.reportType = JSON.parse(JSON.stringify(baseMetadata.reportType));
      if (baseMetadata.detailColumns) meta.detailColumns = JSON.parse(JSON.stringify(baseMetadata.detailColumns));

      const yearDebug: any = {
        year,
        sentGroupingsDown: meta.groupingsDown,
        sentStandardDateFilter: meta.standardDateFilter,
        sentReportFiltersCount: (meta.reportFilters || []).length
      };

      // Execute the report
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
        const errText = await runResp.text();
        console.error(`Markets report error for ${year}: ${runResp.status} ${errText}`);
        yearDebug.error = { status: runResp.status, body: errText.substring(0, 500) };
        return { data: [], debug: yearDebug };
      }

      const reportData = await runResp.json();

      // Capture response shape for debugging
      const groupings = reportData.groupingsDown?.groupings || [];
      yearDebug.groupingsReturnedCount = groupings.length;
      yearDebug.sampleGroupings = groupings.slice(0, 5).map((g: any) => ({ key: g.key, label: g.label, value: g.value }));
      yearDebug.factMapKeys = Object.keys(reportData.factMap || {}).slice(0, 10);
      yearDebug.hasGroupingsAcross = !!(reportData.groupingsAcross?.groupings?.length);

      // Get aggregate column info
      const aggInfo = reportData.reportExtendedMetadata?.aggregateColumnInfo || {};
      const aggKeys = Object.keys(aggInfo);
      yearDebug.aggregateColumns = aggKeys.map(k => ({ key: k, label: aggInfo[k]?.label, dataType: aggInfo[k]?.dataType }));

      // Find Amount and Count aggregate indices
      let amountIdx = -1;
      let countIdx = -1;
      for (let i = 0; i < aggKeys.length; i++) {
        const info = aggInfo[aggKeys[i]];
        const label = (info?.label || '').toLowerCase();
        const key = aggKeys[i].toLowerCase();
        if (label.includes('amount') || key.includes('amount')) {
          amountIdx = i;
        }
        if (label === 'record count' || key === 'rowcount') {
          countIdx = i;
        }
      }
      yearDebug.amountIdx = amountIdx;
      yearDebug.countIdx = countIdx;

      // Parse groupings into market data
      const factMap = reportData.factMap || {};
      const results: MarketYearData[] = [];

      for (const group of groupings) {
        const market = String(group.label || group.value || 'Unknown').trim();
        if (!market || market === '-') continue;

        const factKey = `${group.key}!T`;
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

        if (amount > 0 || count > 0) {
          results.push({
            market,
            year,
            amount: Math.round(amount * 100) / 100,
            count
          });
        }
      }

      yearDebug.parsedResultsCount = results.length;
      return { data: results, debug: yearDebug };
    }

    // 4) Run for both years in parallel
    const [latestResult, priorResult] = await Promise.all([
      runForYear(latestYear),
      runForYear(priorYear)
    ]);

    debugLog.latestYearDebug = latestResult.debug;
    debugLog.priorYearDebug = priorResult.debug;

    // 5) Combine results
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
    console.error('Markets Salesforce API error:', err);
    return res.status(500).json({
      error: 'Unexpected Salesforce markets API error',
      details: err.message || String(err),
      _debug: debugLog
    });
  }
}
