import Head from 'next/head';
import Link from 'next/link';

export default function Home() {
  return (
    <>
      <Head>
        <title>HAVEN Lifestyles - Sales Dashboard</title>
      </Head>
      <main
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0c0f14',
          color: '#e8eaed',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: '2rem'
        }}
      >
        <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>HAVEN Lifestyles - Weekly Sales Dashboard</h1>
        <p style={{ marginBottom: '1.5rem', color: '#8b919e' }}>
          Open the Salesforce-powered dashboard (no browser login required).
        </p>
        <Link
          href="/revenucomp_salesforce.html"
          style={{
            padding: '0.75rem 1.5rem',
            borderRadius: '999px',
            border: '1px solid #e8a838',
            background: '#e8a838',
            color: '#0c0f14',
            textDecoration: 'none',
            fontWeight: 500
          }}
        >
          Open Dashboard
        </Link>
      </main>
    </>
  );
}

