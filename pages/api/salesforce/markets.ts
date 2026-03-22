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
 * Markets API — uses SOQL aggregate queries instead of the Report API.
 * The Report API kept failing due to chart/grouping conflicts when we
 * tried to override groupingsDown. SOQL gives us full control:
 *   SELECT Market_formula__c, SUM(Amount), COUNT(Id)
 *   FROM Opportunity
 *   WHERE <filters matching the report>
 *   GROUP BY Market_formula__c
 *
 * Field names sourced from the report's describe metadata:
 *   - Market: Opportunity.Market_formula__c
 *   - Date:   Opportunity.Sales_Date__c
 *   - Step:   Opportunity.Contract_Step__c (equals '' or '1')
 *   - Amount: Amount (standard, > 0)
 *   - Agreement: Opportunity.Agreement_Type_From_Agreement__c (not blank)
 *   - Vertical: Opportunity.Vertical__c (specific list)
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
      SALESFORCE_API_VERSION
    } = process.env;

    if (!SALESFORCE_INSTANCE_URL) {
      return res.status(500).json({ error: 'Salesforce instance URL not configured' });
    }

    const apiVersion = SALESFORCE_API_VERSION || 'v62.0';
    const accessToken = await getAccessToken();

    const now = new Date();
    const latestYear = now.getFullYear();
    const priorYear = latestYear - 1;

    // Verticals from the report filter
    const verticals = [
      'Appraiser', "Buyer's Agent", 'Editorial', 'Home Builder',
      'Home Inspector', 'Interior Designer', 'Landscaper', 'Lender',
      'Not Listed', 'Organizing', 'Other', 'Power Services',
      'Real Estate Photographer', 'Real Estate and Lifestyles',
      'Recently Sold + Pending', 'Solar', 'Staging', 'Title',
      'Vacation Rental Consulting', 'Water Treatment', 'Yachts'
    ];
    const verticalList = verticals.map(v => `'${v.replace(/'/g, "\\'")}'`).join(',');

    // Build SOQL for a given year range
    function buildQuery(startDate: string, endDate: string): string {
      return `SELECT Market_formula__c mkt, SUM(Amount) amt, COUNT(Id) cnt `
        + `FROM Opportunity `
        + `WHERE Sales_Date__c >= ${startDate} `
        + `AND Sales_Date__c <= ${endDate} `
        + `AND Amount > 0 `
        + `AND (Contract_Step__c = null OR Contract_Step__c = '' OR Contract_Step__c = '1') `
        + `AND Agreement_Type_From_Agreement__c != null `
        + `AND Agreement_Type_From_Agreement__c != '' `
        + `AND (Vertical__c = null OR Vertical__c IN (${verticalList})) `
        + `AND Market_formula__c != null `
        + `AND Market_formula__c != '' `
        + `GROUP BY Market_formula__c `
        + `ORDER BY SUM(Amount) DESC`;
    }

    async function runQuery(year: number): Promise<{ data: MarketYearData[]; debug: any }> {
      const startDate = `${year}-01-01`;
      let endDate: string;
      if (year === latestYear) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else {
        endDate = `${year}-12-31`;
      }

      const soql = buildQuery(startDate, endDate);
      const yearDebug: any = { year, soql };

      const queryUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;
      const resp = await fetch(queryUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`SOQL error for ${year}: ${resp.status} ${errText}`);
        yearDebug.error = { status: resp.status, body: errText.substring(0, 1000) };
        return { data: [], debug: yearDebug };
      }

      const result = await resp.json();
      yearDebug.totalSize = result.totalSize;
      yearDebug.done = result.done;
      yearDebug.sampleRecords = (result.records || []).slice(0, 3);

      const data: MarketYearData[] = [];
      for (const rec of (result.records || [])) {
        const market = String(rec.mkt || rec.Market_formula__c || 'Unknown').trim();
        if (!market) continue;

        const amount = parseFloat(rec.amt || rec.expr0 || '0');
        const count = parseInt(rec.cnt || rec.expr1 || '0', 10);

        if (amount > 0 || count > 0) {
          data.push({
            market,
            year,
            amount: Math.round(amount * 100) / 100,
            count
          });
        }
      }

      yearDebug.parsedCount = data.length;
      return { data, debug: yearDebug };
    }

    // Run both years in parallel
    const [latestResult, priorResult] = await Promise.all([
      runQuery(latestYear),
      runQuery(priorYear)
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
