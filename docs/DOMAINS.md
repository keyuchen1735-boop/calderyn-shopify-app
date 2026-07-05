# Calderyn domains — the map

One page, every domain, what it's for, and what you can ignore. Updated 2026-07-03.

## The two domains that matter

| Domain | What it is | Vercel project |
|---|---|---|
| **calderyncompany.com** | Marketing site: landing page, waitlist, FAQ, founders. Has a **Sign in** link in the nav. `/login` and `/signup` redirect to the app; `/dashboard/*` is proxied to the app for existing sessions. | `calderyn-waitlist` (repo `Mezoh/calderyn-waitlist`) |
| **app.calderyncompany.com** | The product. Sign in at `/login`, create an account at `/signup`, dashboard at `/dashboard`. This repo. | `shopify-app` |

The user flow: **calderyncompany.com → Sign in → app.calderyncompany.com/login → /dashboard**.

## Supporting domains (keep, but you rarely think about them)

| Domain | What it is |
|---|---|
| **calderyn-mcp.vercel.app** | The MCP resource server behind the customer-facing Claude connector (`/mcp`). Separate project by design (ADR 0001). Live — do not delete. |
| **calderyn-test.vercel.app** | Storefront of the `calderyn-test` demo shop (tenant storefront). Now a **project domain**, so it follows every production deploy automatically — no more manual re-aliasing. |
| **mvp-rehearsal-co-36ea83.vercel.app** | Storefront of the MVP first-sale rehearsal shop. Also an auto-following project domain now. |

### Pretty tenant URLs — LIVE (2026-07-03)

Wildcard DNS is in place: `*.calderyncompany.com → A 76.76.21.21` (added in
**Squarespace Domains**, where the zone lives — the registrar's
`ns-cloud-e*.googledomains.com` nameservers are Squarespace's Google-inherited
infrastructure; the zone is NOT in any of our GCP projects, and the owning
Squarespace login is Eric's, not john@calderyncompany.com).

Live and verified over HTTPS with correct per-tenant routing:
`calderyn-test.calderyncompany.com/storefront` and
`mvp-rehearsal-co-36ea83.calderyncompany.com/storefront`. The old vercel.app
aliases keep working as fallbacks.

**New shops register their storefront host automatically at signup.**
`provisionOwnedShop` calls the Vercel API (`app/lib/storefront/vercel-domain.server.ts`,
needs `VERCEL_TOKEN` in the app env) to attach `<org_slug>.calderyncompany.com`
to the project and issue the cert — best-effort, never blocks signup. For
one-offs the manual command still works, and existing shops (or failed
registrations) can be replayed with `node scripts/backfill-tenant-domains.mjs`:

    vercel domains add <shop-slug>.calderyncompany.com

The storefront resolver routes by the first host label (org_slug or
myshopify handle). Mail and existing hosts are unaffected: `app`, `send`,
`_dmarc`, `resend._domainkey` all have explicit records, which always win
over the wildcard.

## Noise you can safely ignore

- `shopify-<hash>-keyuchen1735-boops-projects.vercel.app` — Vercel mints one of
  these per deployment. Internal build URLs; never user-facing; can't be turned off.
- `shopify-app-git-<branch>-….vercel.app` — per-branch preview URLs, same deal.
- `shopify-app-rho-ruby.vercel.app` / `shopify-app-keyuchen1735-boops-projects.vercel.app` —
  Vercel's default project aliases for the app; app.calderyncompany.com is the real name.

## Removed

- `calderynshopify` (Vercel project) — deleted 2026-07-03. It served the
  abandoned parallel codebase and had been returning 404 for weeks; nothing
  referenced it.
