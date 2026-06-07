import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [
  { title: "Terms of Service & EULA — Calderyn" },
  {
    name: "description",
    content:
      "Terms of Service and End-User License Agreement governing use of the Calderyn application.",
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

export default function Terms() {
  return (
    <main style={wrap}>
      <h1 style={h1}>Terms of Service &amp; End-User License Agreement</h1>
      <p style={meta_}>Last updated: {LAST_UPDATED}</p>

      <p>
        These Terms of Service and End-User License Agreement (&ldquo;Terms&rdquo;)
        are a legal agreement between you, the merchant or business installing or
        using the Calderyn application (&ldquo;you&rdquo;), and Calderyn
        (&ldquo;Calderyn,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or
        &ldquo;our&rdquo;). By installing, accessing, or using the Calderyn
        application and related services (the &ldquo;Service&rdquo;), you agree to be
        bound by these Terms. If you do not agree, do not install or use the Service.
      </p>

      <h2 style={h2}>1. License grant</h2>
      <p>
        Subject to your compliance with these Terms, Calderyn grants you a limited,
        non-exclusive, non-transferable, non-sublicensable, revocable license to
        access and use the Service for your internal business purposes during the
        term of your use. We reserve all rights not expressly granted.
      </p>

      <h2 style={h2}>2. Eligibility and accounts</h2>
      <p>
        You must have a valid Shopify store and the authority to bind the business on
        whose behalf you install the Service. You are responsible for maintaining the
        confidentiality of your credentials and for all activity that occurs under
        your account.
      </p>

      <h2 style={h2}>3. Connected services</h2>
      <p>
        The Service can connect to third-party platforms you authorize, including
        Shopify, advertising platforms, and Intuit QuickBooks Online. Your use of
        those platforms is governed by their respective terms, and you authorize
        Calderyn to access and process data from them solely to provide the Service.
        For QuickBooks Online, the Service uses read-only access to inventory item
        cost and SKU data, as described in our{" "}
        <a href="/privacy">Privacy Policy</a>. You may disconnect any connected
        service at any time.
      </p>

      <h2 style={h2}>4. Acceptable use</h2>
      <p>
        You agree not to: (a) reverse engineer, decompile, or attempt to derive the
        source code of the Service except where permitted by law; (b) resell, rent,
        or provide the Service to third parties except as the Service is intended; (c)
        interfere with or disrupt the integrity or performance of the Service; (d)
        access the Service to build a competing product; or (e) use the Service in
        violation of any applicable law or third-party terms.
      </p>

      <h2 style={h2}>5. Intellectual property</h2>
      <p>
        The Service, including all software, design, and content provided by
        Calderyn, is owned by Calderyn and its licensors and is protected by
        intellectual-property laws. These Terms do not transfer any ownership to you.
        You retain all rights to your own data; you grant us the rights necessary to
        process that data to provide the Service.
      </p>

      <h2 style={h2}>6. Data and privacy</h2>
      <p>
        Our collection and use of data is described in the{" "}
        <a href="/privacy">Privacy Policy</a>, which is incorporated into these Terms
        by reference. You represent that you have the right to provide us with, and
        authorize us to process, the data made available through your connected
        accounts.
      </p>

      <h2 style={h2}>7. Fees</h2>
      <p>
        If the Service or any portion of it is offered for a fee, applicable pricing
        and billing terms will be presented to you at the point of purchase or
        through the Shopify billing system. Unless stated otherwise, fees are
        non-refundable except as required by law.
      </p>

      <h2 style={h2}>8. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo;
        WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY,
        INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
        PURPOSE, AND NON-INFRINGEMENT. Calderyn does not warrant that the Service will
        be uninterrupted, error-free, or that analytics it produces are suitable for
        accounting, tax, or financial-reporting purposes. You are responsible for
        independently verifying figures before relying on them.
      </p>

      <h2 style={h2}>9. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, CALDERYN WILL NOT BE LIABLE FOR ANY
        INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY
        LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING OUT OF OR RELATED TO YOUR
        USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM ARISING OUT OF OR
        RELATED TO THE SERVICE WILL NOT EXCEED THE AMOUNTS YOU PAID TO US FOR THE
        SERVICE IN THE TWELVE MONTHS PRECEDING THE CLAIM, OR USD $100 IF YOU PAID
        NOTHING.
      </p>

      <h2 style={h2}>10. Indemnification</h2>
      <p>
        You agree to indemnify and hold harmless Calderyn from and against any claims,
        damages, liabilities, and expenses arising out of your use of the Service in
        violation of these Terms or applicable law.
      </p>

      <h2 style={h2}>11. Termination</h2>
      <p>
        You may stop using and uninstall the Service at any time. We may suspend or
        terminate your access if you breach these Terms or if necessary to protect the
        Service. Upon termination, the license granted to you ends and we will handle
        your data as described in the Privacy Policy.
      </p>

      <h2 style={h2}>12. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. We will revise the &ldquo;Last
        updated&rdquo; date above and, where appropriate, provide additional notice.
        Continued use of the Service after an update constitutes acceptance of the
        revised Terms.
      </p>

      <h2 style={h2}>13. Governing law</h2>
      <p>
        These Terms are governed by the laws of the United States and the state in
        which Calderyn is established, without regard to conflict-of-laws principles.
      </p>

      <h2 style={h2}>14. Contact</h2>
      <p>
        Questions about these Terms can be sent to{" "}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </main>
  );
}
