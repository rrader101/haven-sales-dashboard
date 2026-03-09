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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      SALESFORCE_INSTANCE_URL,
      SALESFORCE_REPORT_ID_WEEKLY: REPORT_ID,
      SALESFORCE_API_VERSION
    } = process.env;

    if (!SALESFORCE_INSTANCE_URL || !REPORT_ID) {
      return res.status(500).json({ error: 'Salesforce instance URL or weekly report ID not configured' });
    }

    const apiVersion = SALESFORCE_API_VERSION || 'v59.0';
    const accessToken = await getAccessToken();

    // 1) Describe to clone metadata
    const describeUrl = `${SALESFORCE_INSTANCE_URL}/services/data/${apiVersion}/analytics/reports/${REPORT_ID}/describe`;
    const describeResp = await fetch(describeUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!describeResp.ok) {
      const text = await describeResp.text();
      return res
        .status(502)
        .json({ error: 'Error describing Salesforce weekly report', details: text, status: describeResp.status });
    }

    const describeData = await describeResp.json();
    const metadata = describeData.reportMetadata;

    // Nudge upper-bound date filter (Sales_Date__c or CloseDate) slightly forward to avoid stale caching
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

    // 2) Run the report with updated metadata
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
      return res
        .status(502)
        .json({ error: 'Error running Salesforce weekly report', details: text, status: runResp.status });
    }

    const reportData = await runResp.json();
    return res.status(200).json(reportData);
  } catch (err: any) {
    console.error('Weekly Salesforce API error:', err);
    return res.status(500).json({ error: 'Unexpected Salesforce weekly API error', details: err.message || String(err) });
  }
}

