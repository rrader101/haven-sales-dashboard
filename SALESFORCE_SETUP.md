# Salesforce Setup Guide for HAVEN Lifestyles Sales Dashboard

## Overview

This guide walks you through connecting the Weekly Sales Dashboard (`revenucomp_salesforce.html`) to your Salesforce org for live data.

## Step 1: Create a Connected App in Salesforce

1. Log in to Salesforce and go to **Setup**
2. In Quick Find, search for **App Manager**
3. Click **New Connected App**
4. Fill in the basics:
   - **Connected App Name**: `HAVEN Sales Dashboard`
   - **API Name**: `HAVEN_Sales_Dashboard`
   - **Contact Email**: your email
5. Under **API (Enable OAuth Settings)**:
   - Check **Enable OAuth Settings**
   - **Callback URL**: Enter the full URL where the dashboard is hosted (e.g., `https://yourdomain.com/revenucomp_salesforce.html`)
   - **Selected OAuth Scopes**: Add these:
     - `Access the identity URL service (id, profile, email, address, phone)`
     - `Manage user data via APIs (api)`
   - Check **Require Proof Key for Code Exchange (PKCE)**
   - Check **Require Secret for Web Server Flow** should be UNCHECKED (we use PKCE instead)
6. Click **Save**, then **Continue**
7. Copy the **Consumer Key** — you'll need this for the dashboard

## Step 2: Whitelist Your Domain for CORS

1. In Salesforce Setup, search for **CORS**
2. Click **CORS** under Security
3. Click **New**
4. Enter your dashboard's origin URL (e.g., `https://yourdomain.com`) — no trailing slash, no path
5. Click **Save**

## Step 3: Configure the Dashboard

1. Open `revenucomp_salesforce.html` in your browser
2. In the **Salesforce Connection** panel at the top:
   - Enter your **Instance URL** (e.g., `https://yourorg.my.salesforce.com`)
   - Enter the **Client ID** (Consumer Key from Step 1)
3. Click **Connect to Salesforce**
4. You'll be redirected to Salesforce to log in and authorize the app
5. After authorization, you'll be redirected back and the dashboard will load with live data

## What Data Is Queried

The dashboard runs this SOQL query against your Opportunity object:

```sql
SELECT CALENDAR_YEAR(CloseDate) yr,
       WEEK_IN_YEAR(CloseDate) wk,
       SUM(Amount) total,
       COUNT(Id) cnt
FROM Opportunity
WHERE CloseDate >= 2024-01-01 AND IsWon = true
GROUP BY CALENDAR_YEAR(CloseDate), WEEK_IN_YEAR(CloseDate)
ORDER BY CALENDAR_YEAR(CloseDate), WEEK_IN_YEAR(CloseDate)
```

This pulls all **Closed Won** opportunities from 2024 onwards, grouped by ISO week.

## Troubleshooting

**"CORS error" or "Failed to fetch"**
Your dashboard's domain isn't whitelisted in Salesforce CORS settings. See Step 2.

**"Session expired"**
Salesforce access tokens expire after ~2 hours. Click **Refresh Data** or reconnect.

**"No opportunity data found"**
Either there are no Closed Won opportunities in the date range, or the connected user doesn't have permission to query Opportunities.

**Dashboard shows no data after connecting**
Check the browser console (F12 → Console) for detailed error messages.

## Security Notes

- The Client ID is safe to store in browser localStorage — it's not a secret
- Access tokens are stored in sessionStorage only (cleared when the browser tab closes)
- No client secret is used (PKCE replaces it)
- All communication with Salesforce uses HTTPS
