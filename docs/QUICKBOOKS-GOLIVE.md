# QuickBooks Production Go-Live — Handoff

**Goal:** Unlock **Production** QuickBooks Online credentials so real merchants (not just the sandbox) can connect. The integration is already built, merged, and deployed — this is purely Intuit's production checklist plus a tiny config swap at the end.

**Where:** developer.intuit.com → app **"Calderyn"** → **Keys & credentials** → **Production** tab → "Complete these tasks in any order to unlock your production credentials."

**Two groups:** **App details** (~10 min) and **Compliance** (~40 min security questionnaire). Both must hit 100%.

---

## Key facts you'll need throughout

| Thing | Value |
|---|---|
| App (Shopify embedded) URL | `https://shopify-app-rho-ruby.vercel.app` |
| OAuth redirect URI | `https://shopify-app-rho-ruby.vercel.app/auth/quickbooks` |
| Hosting | Vercel (serverless functions, region `pdx1` / US-West) |
| Database | Supabase Postgres (AWS `us-west-2`), RLS enabled |
| OAuth scope used | `com.intuit.quickbooks.accounting` (we only **read** Item purchase cost) |
| Data we store from QBO | Only product **unit cost** (per SKU) + the encrypted OAuth **refresh token**. No customer/financial PII. |
| Token security | Refresh token encrypted at rest (AES-256-GCM) in `integration_credentials`; rotated on every sync |
| Transport | HTTPS/TLS everywhere |

---

## App details group (6 items)

### 1. Review Intuit Developer Portal Profile + verify email
- Confirm the account email is verified.
- Fill the developer profile (company = Calderyn, contact info). Straightforward.

### 2. End-user license agreement (EULA) + privacy policy URLs
⚠️ **Needs two real, publicly reachable pages.** Intuit requires a hosted **privacy policy** URL and **EULA / terms** URL.
- We don't have these published yet. **Action:** host a privacy policy and a EULA/terms page and paste their URLs.
- Easiest home: the public waitlist/landing site (`calderyn-waitlist.vercel.app`) — e.g. `…/privacy` and `…/terms` — or the app domain. Your call where they live; they just need to be live HTTPS URLs.

### 3. Host domain + launch URL + disconnect URL + connect/reconnect URL
Paste these (adjust if you prefer a different launch/disconnect target):
- **Host domain:** `shopify-app-rho-ruby.vercel.app`
- **Launch URL:** `https://shopify-app-rho-ruby.vercel.app/app`
- **Connect / reconnect URL:** `https://shopify-app-rho-ruby.vercel.app/app/settings`
- **Disconnect URL:** `https://shopify-app-rho-ruby.vercel.app/auth/quickbooks/disconnect`
  - Dedicated public landing page. Credential teardown is server-side: the next sync detects the revoked token (`invalid_grant`) and marks the integration disconnected.

### 4. Select a category
- Choose **Accounting** (or closest: "Business management" / "Other").

### 5. Regulated industries
- **No / none.** (Calderyn is an e-commerce ad-profit tool; not healthcare/finance-regulated.)

### 6. Where the app is hosted
- **Vercel** (cloud / serverless). Country: **United States**.

---

## Compliance group (~40 min security questionnaire)

Intuit's app-assessment / security questions. Answer from the facts in the table above. Typical questions + our reality:

- **Where is data stored?** Supabase Postgres, AWS `us-west-2` (United States).
- **Is data encrypted at rest / in transit?** In transit: TLS/HTTPS. At rest: OAuth tokens encrypted (AES-256-GCM) at the application layer; database is Supabase-managed Postgres with encryption at rest and row-level security enabled.
- **What QuickBooks data do you access/store?** Read-only `accounting` scope; we read inventory **Item purchase cost** and SKU, and store only the per-SKU unit cost. No invoices, customers, or financial statements stored.
- **How are access tokens handled?** Refresh token stored encrypted, rotated on every sync; never logged; never exposed to the browser/client.
- **Who can access the data?** Server-side only (Vercel functions using a Supabase service role); no third-party sharing.
- **Auth model?** Shopify embedded-app OAuth for the merchant; QuickBooks OAuth 2.0 for the QBO link.

(If a question doesn't apply, answer honestly — e.g. no mobile app, no PCI card data, etc.)

---

## After the checklist is 100% → Production keys unlock

1. On the **Production** tab, copy the **Client ID** and **Client Secret**.
2. Add the **redirect URI** under Production:
   `https://shopify-app-rho-ruby.vercel.app/auth/quickbooks`
3. Hand the production Client ID + Secret back (or set them yourself in Vercel):
   - Vercel → **shopify-app** project → Settings → Environment Variables → **Production**:
     - `QBO_CLIENT_ID` = (production client id)
     - `QBO_CLIENT_SECRET` = (production client secret)
     - `QBO_ENV` = `production`   ← **flip from `sandbox`**
   - Redeploy (or it picks up on next deploy).

**Code change required: none.** `QBO_ENV=production` automatically switches the app to the live QuickBooks API host (`app/lib/quickbooks/client.server.ts → qboApiBase`). Everything else is already in place.

---

## Status reference (already done)

- ✅ Integration built (OAuth + daily COGS sync), merged (PR #12) and deployed to prod.
- ✅ Settings "Connect QuickBooks" button live (PR #13).
- ✅ Sandbox connect verified end-to-end; cost-pull confirmed (a `$10` test cost arrived in the raw QuickBooks response).
- ⏳ Sandbox SKU match couldn't be demoed because Intuit's **sandbox** doesn't expose item SKUs via its API even when shown in the UI — a sandbox-only quirk; the match logic is covered by automated tests and works on real production data.
- 🎯 This handoff = the only thing between us and real merchants.
