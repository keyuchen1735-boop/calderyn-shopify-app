import type { MetaFunction } from "react-router";

// Public landing page for Intuit's "Disconnect URL". When a merchant disconnects
// Calderyn from inside QuickBooks, Intuit redirects them here. No auth, no loader
// — the actual credential teardown happens server-side on the next sync, which
// detects the revoked token (invalid_grant) and marks the integration
// disconnected (see cron.ingest-quickbooks + isRevokedTokenError). Mirrors the
// plain public-page pattern of privacy.tsx / terms.tsx.

export const meta: MetaFunction = () => [
  { title: "QuickBooks disconnected — Calderyn" },
  { name: "robots", content: "noindex" },
];

const wrap: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  color: "#1a1a1a",
  lineHeight: 1.6,
  maxWidth: 560,
  margin: "0 auto",
  padding: "64px 24px 96px",
  textAlign: "center",
};

export default function QuickbooksDisconnected() {
  return (
    <main style={wrap}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>QuickBooks disconnected</h1>
      <p>
        Calderyn is no longer connected to your QuickBooks Online company. We&rsquo;ve stopped
        syncing your product costs, and we won&rsquo;t access your QuickBooks data again unless
        you reconnect.
      </p>
      <p>
        To reconnect later, open Calderyn in your Shopify admin and choose{" "}
        <strong>Settings → Connect QuickBooks</strong>.
      </p>
    </main>
  );
}
