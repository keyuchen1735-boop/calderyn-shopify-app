import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy — Calderyn" },
  {
    name: "description",
    content:
      "How Calderyn collects, uses, stores, and protects data, including data accessed from QuickBooks Online.",
  },
];

const LAST_UPDATED = "June 7, 2026";
const CONTACT_EMAIL = "john@calderyncompany.com";

const wrap: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  color: "#1a1a1a",
  lineHeight: 1.6,
  maxWidth: 760,
  margin: "0 auto",
  padding: "48px 24px 96px",
};
const h1: React.CSSProperties = { fontSize: 32, marginBottom: 4 };
const h2: React.CSSProperties = { fontSize: 20, marginTop: 40, marginBottom: 8 };
const meta_: React.CSSProperties = { color: "#666", fontSize: 14, marginTop: 0 };

export default function Privacy() {
  return (
    <main style={wrap}>
      <h1 style={h1}>Privacy Policy</h1>
      <p style={meta_}>Last updated: {LAST_UPDATED}</p>

      <p>
        Calderyn (&ldquo;Calderyn,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
        &ldquo;our&rdquo;) provides an ad-and-inventory analytics application that
        installs into a merchant&rsquo;s Shopify store and, optionally, connects to
        third-party services the merchant authorizes (such as advertising platforms
        and QuickBooks Online). This Privacy Policy explains what information we
        collect, how we use it, how we store and protect it, and the choices
        available to merchants. It applies to the Calderyn application and related
        services (collectively, the &ldquo;Service&rdquo;).
      </p>

      <h2 style={h2}>Who this policy is for</h2>
      <p>
        Calderyn is a business-to-business tool used by Shopify merchants. We do not
        market the Service to consumers and do not knowingly collect personal
        information from a merchant&rsquo;s end customers beyond what Shopify provides
        as part of normal app operation.
      </p>

      <h2 style={h2}>Information we collect</h2>
      <p>
        <strong>Shopify store data.</strong> When a merchant installs Calderyn, we
        access store data through the Shopify Admin API using the permissions the
        merchant grants during installation. This includes product, inventory, and
        order information used to compute advertising and margin analytics. We store
        the Shopify session and access token needed to operate the app.
      </p>
      <p>
        <strong>Connected advertising platforms.</strong> If a merchant connects an
        advertising account (for example Google, Meta, or TikTok), we access campaign
        and spend metrics for that account to attribute ad cost against product
        margin.
      </p>
      <p>
        <strong>QuickBooks Online data.</strong> If a merchant connects QuickBooks
        Online, we use the <code>com.intuit.quickbooks.accounting</code> scope and
        issue read-only queries. We read inventory <em>Item</em> records and use only
        two fields: the item SKU and its purchase (unit) cost. We store only the
        per-SKU unit cost, time-versioned so cost changes can be tracked. We do{" "}
        <strong>not</strong> access or store invoices, customers, vendors, bank or
        card data, payroll, tax filings, or financial statements.
      </p>
      <p>
        <strong>Authentication tokens.</strong> To maintain connections we store
        OAuth credentials, including the QuickBooks refresh token. Refresh tokens are
        encrypted at the application layer (AES-256-GCM) before they are written to
        our database and are rotated on every synchronization.
      </p>
      <p>
        <strong>Operational data.</strong> We retain limited logs and raw API
        response payloads needed to run, debug, and audit synchronizations. For
        QuickBooks, the retained payload contains only the inventory item fields
        described above; it does not contain customer or financial PII.
      </p>

      <h2 style={h2}>How we use information</h2>
      <p>
        We use the information above solely to provide and improve the Service:
        computing cost of goods sold and margin, attributing advertising spend,
        surfacing analytics and alerts inside the Shopify admin, and keeping
        connected integrations synchronized. We do not use QuickBooks data for
        advertising, profiling unrelated to the merchant&rsquo;s own analytics, or
        any purpose beyond delivering the Service to that merchant.
      </p>

      <h2 style={h2}>How we store and protect data</h2>
      <p>
        Data is stored in a managed PostgreSQL database (Supabase) hosted on AWS in
        the United States (<code>us-west-2</code>). The database provides encryption
        at rest and we enable row-level security to isolate each merchant&rsquo;s
        data. All data in transit is protected with HTTPS/TLS. OAuth refresh tokens
        receive an additional layer of application-level encryption (AES-256-GCM) and
        are never exposed to the browser or written to logs. Application access to the
        database is server-side only, using a privileged service credential held in
        our hosting environment.
      </p>

      <h2 style={h2}>How we share information</h2>
      <p>
        We do not sell personal information and we do not share merchant data with
        third parties for their own marketing. We share data only with the
        infrastructure providers that operate the Service on our behalf — our hosting
        provider (Vercel) and our database provider (Supabase) — and only as needed
        to run the Service. We may disclose information if required by law or to
        protect the rights, safety, or security of Calderyn, our merchants, or the
        public.
      </p>

      <h2 style={h2}>Data retention and deletion</h2>
      <p>
        We retain data for as long as a merchant uses the Service. A merchant may
        disconnect QuickBooks or any other integration at any time from the
        Calderyn settings page; disconnecting stops further synchronization. When a
        merchant uninstalls the app or requests deletion, we delete or de-identify
        the associated data, and we honor Shopify&rsquo;s mandatory data-erasure
        (GDPR) webhooks. To request deletion directly, contact us at the address
        below.
      </p>

      <h2 style={h2}>Merchant choices</h2>
      <p>
        Connecting QuickBooks Online and any advertising platform is optional and
        initiated by the merchant. Merchants control which accounts are connected and
        can revoke access at any time, either from within Calderyn or from the
        connected provider&rsquo;s own account settings (for example, by revoking
        Calderyn&rsquo;s access from the Intuit account&rsquo;s connected-apps
        screen).
      </p>

      <h2 style={h2}>International users</h2>
      <p>
        The Service is operated from the United States and data is processed there.
        By using the Service, merchants understand that their data will be processed
        in the United States.
      </p>

      <h2 style={h2}>Changes to this policy</h2>
      <p>
        We may update this Privacy Policy from time to time. When we do, we will
        revise the &ldquo;Last updated&rdquo; date above and, where appropriate,
        provide additional notice. Continued use of the Service after an update
        constitutes acceptance of the revised policy.
      </p>

      <h2 style={h2}>Contact us</h2>
      <p>
        Questions about this policy or your data can be sent to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </main>
  );
}
