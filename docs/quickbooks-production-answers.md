# QuickBooks Production — Copy-Paste Answer Sheet

Everything below is grounded in the actual Calderyn code (verified June 7, 2026), not assumptions.
Use it to fill **developer.intuit.com → Calderyn → Keys & credentials → Production**.

> **Two placeholders to confirm before you submit:**
> - **Privacy / EULA URLs** — the new `/privacy` and `/terms` pages must be **deployed and live** first (see bottom).
> - **Published contact email** — the legal pages currently say `support@calderyn.app`. Change it if you want a different address.

---

## App details group

### 1. Developer profile + verified email
- Confirm the Intuit account email is **verified** (resend the verification mail if needed).
- Company / developer name: **Calderyn**
- Contact: your name + email + phone as the developer contact.

### 2. EULA + Privacy Policy URLs
| Field | Value |
|---|---|
| Privacy Policy URL | `https://shopify-app-rho-ruby.vercel.app/privacy` |
| EULA / Terms URL | `https://shopify-app-rho-ruby.vercel.app/terms` |

*(These resolve only after the new routes are deployed — see "Deploy the legal pages" below. If you'd rather host them on the waitlist site, the URLs would be `https://calderyn-waitlist.vercel.app/privacy` and `/terms` instead.)*

### 3. URLs
| Field | Value |
|---|---|
| Host domain | `shopify-app-rho-ruby.vercel.app` |
| Launch URL | `https://shopify-app-rho-ruby.vercel.app/app` |
| Connect / reconnect URL | `https://shopify-app-rho-ruby.vercel.app/app/settings` |
| Disconnect URL | `https://shopify-app-rho-ruby.vercel.app/auth/quickbooks/disconnect` |

### 4. Category
- **Accounting** (closest fallback: *Business management*).

### 5. Regulated industries
- **None.** Calderyn is an e-commerce advertising/inventory analytics tool. It is not in healthcare, lending, insurance, or any regulated financial-services category.

### 6. Hosting
- Hosted on **Vercel** (cloud / serverless functions), region `pdx1`, **United States**.

---

## Compliance / security questionnaire

Answer with the merchant-data reality below. Phrasing is written to paste directly.

### General Questions (confirmed)

1. **Complaints/lawsuits/investigations from regulators?** — Your call; almost certainly **No**.
2. **Worked with legal counsel on regulatory requirements?** — Your call (**No** unless you actually have).
3. **Reviewed & will comply with the linked security policies?** — **Yes** (skim the linked page first; it's an attestation).
4. **Is the app designed to enhance QuickBooks / facilitate a business process?** — **Yes** (it facilitates a business process: syncing QBO item cost into Shopify margin analytics).
5. **Sanctions-list / embargoed-jurisdiction declaration?** — **No** (legal attestation — your call).
6. **Does the app involve generative AI?** — **Yes.** Uses Anthropic Claude (`claude-sonnet-4-6`) for an in-app assistant and a server-side analysis layer. Suggested description:
   > The app includes an in-app AI assistant powered by Anthropic Claude that helps the merchant understand their own store data (alerts, campaigns, SKUs/inventory, audit log, guardrails) in plain language. It is read-only for actions — it can propose an action tied to an existing alert but never executes; the merchant confirms. Data sent to the model is the merchant's own operational snapshot and tool results; this may include product unit-cost figures (some derived from QuickBooks) but no QuickBooks customer or financial PII. Generative AI is also used server-side to help generate and explain alerts.
7. **Is QuickBooks data used for training?** — **No.** No QuickBooks data trains or fine-tunes any AI model, and Anthropic's API doesn't train on it. (Optional transparency note if there's an explanation box: an internal detection-threshold model learns from a derived dollar-impact signal that may include COGS; raw QuickBooks data is never used, and any cross-merchant aggregation is consent-gated and k-anonymized.)

> Items 1, 2, 3, and 5 are legal attestations that must be answered by someone authorized for your organization — do not let anyone else answer these for you.

### Technical sections (App Information / Auth / API Usage / Error Handling / Security)

**What QuickBooks data does your app access and store?**
> We connect with the `com.intuit.quickbooks.accounting` scope and perform read-only queries. We read inventory **Item** records and use only two fields: the item **SKU** and its **purchase (unit) cost**. We store only the per-SKU unit cost (time-versioned to track cost changes). We do not access or store invoices, customers, vendors, bank/card data, payroll, tax data, or financial statements.

**Why do you need this data / what does the app do with it?**
> The unit cost is used to compute cost of goods sold and product margin, which the app attributes against advertising spend to show merchants their true ad profitability inside the Shopify admin.

**Where is data stored? In which country/region?**
> A managed PostgreSQL database (Supabase) hosted on AWS in the United States (`us-west-2`). The application is hosted on Vercel (serverless), also United States.

**Is data encrypted in transit?**
> Yes. All traffic uses HTTPS/TLS, including the OAuth flow and every QuickBooks API call.

**Is data encrypted at rest?**
> Yes. The database provides encryption at rest. In addition, OAuth tokens receive application-layer encryption (AES-256-GCM) before being written, so the refresh token is encrypted independently of the database.

**How are OAuth access/refresh tokens handled?**
> The QuickBooks refresh token is encrypted (AES-256-GCM) at the application layer and stored in an `integration_credentials` table. Access tokens are short-lived and re-derived from the refresh token at sync time. The refresh token is **rotated on every sync** and the new value re-encrypted and persisted. Tokens are never logged and never exposed to the browser/client.

**Who can access the stored data?**
> Server-side application code only, running in Vercel serverless functions using a privileged Supabase service credential. Row-level security is enabled to isolate each merchant's data. No third party is given access; data is not sold or shared for marketing.

**What is your authentication model?**
> Merchants authenticate to the app via Shopify embedded-app OAuth. The QuickBooks link uses QuickBooks OAuth 2.0 (authorization-code grant) with a single-use `state` nonce for CSRF protection on the callback.

**Do you have a mobile app?**
> No. Calderyn is a web application embedded in the Shopify admin.

**Do you store or process payment-card data (PCI)?**
> No. We never handle cardholder data.

**Do you store end-customer or financial PII from QuickBooks?**
> No. We store only inventory SKU and unit cost. No personally identifiable customer or financial information is read or retained from QuickBooks.

**How can a user disconnect / how is data deleted?**
> A merchant can disconnect QuickBooks at any time from the app's Settings page, which stops further synchronization. On app uninstall or deletion request, associated data is deleted/de-identified, and Shopify's mandatory GDPR data-erasure webhooks are honored.

**Do you share data with subprocessors / third parties?**
> Only the infrastructure providers that run the Service on our behalf: Vercel (hosting) and Supabase (database). No data is shared for any third party's own purposes.

**Logging / monitoring?**
> Operational logs and raw API response payloads are retained for debugging and audit. For QuickBooks, the retained payload contains only the inventory item fields above — no customer or financial PII. Tokens and secrets are never logged.

---

## After the checklist hits 100% → unlock + flip to production

1. On the **Production** tab, copy the **Client ID** and **Client Secret**.
2. Under Production, add the redirect URI:
   `https://shopify-app-rho-ruby.vercel.app/auth/quickbooks`
3. In **Vercel → shopify-app project → Settings → Environment Variables → Production**, set:
   - `QBO_CLIENT_ID` = production client id
   - `QBO_CLIENT_SECRET` = production client secret
   - `QBO_ENV` = `production`  ← flip from `sandbox`
4. Redeploy.

**No code change is required.** Confirmed in `app/lib/quickbooks/client.server.ts`: `qboApiBase()` returns the live host `https://quickbooks.api.intuit.com` when `QBO_ENV === "production"`, otherwise the sandbox host. The redirect URI is built as `${SHOPIFY_APP_URL}/auth/quickbooks` in `app/routes/auth.quickbooks.$.tsx`, so it matches the value registered above.

---

## Deploy the legal pages (prerequisite for item #2)

Two new public routes were added to this repo:
- `app/routes/privacy.tsx` → `/privacy`
- `app/routes/terms.tsx` → `/terms`

They are plain public pages (no Shopify auth), mirroring the existing `_index.tsx` pattern. They go live on the next Vercel deploy of the `shopify-app` project. Once deployed, confirm both URLs load over HTTPS before pasting them into Intuit.

> Note: these pages are reasonable, practice-accurate templates — not legal advice. Have someone review them (and confirm the published contact email and governing-law state) before relying on them.
