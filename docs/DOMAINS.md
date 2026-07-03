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

Tenant storefronts use vercel.app subdomains because wildcard DNS
(`*.calderyncompany.com`) isn't set up yet; adding a wildcard record at the DNS
host would give every shop `shopname.calderyncompany.com`.

### Pretty tenant URLs — one step left (owner of the Squarespace account)

DNS for calderyncompany.com lives in **Squarespace Domains** (the registrar; its
`ns-cloud-e*.googledomains.com` nameservers are Squarespace's Google-inherited
infrastructure — the zone is NOT in any of our GCP projects). The Squarespace
account that owns the domain is not john@calderyncompany.com.

Whoever has that login: Squarespace → Domains → calderyncompany.com → DNS →
add ONE custom record:

    Host: *        Type: A        TTL: default        Data: 76.76.21.21

Everything else is already wired: `calderyn-test.calderyncompany.com` and
`mvp-rehearsal-co-36ea83.calderyncompany.com` are attached to the `shopify-app`
Vercel project (pending DNS) and will auto-verify + get certificates the moment
the record exists. The storefront resolver already routes by the first host
label, so any future shop is just one `vercel domains add <slug>.calderyncompany.com`.
The wildcard cannot break mail or existing hosts: `app`, `send`, `_dmarc`,
`resend._domainkey` all have explicit records, which always win over `*`.

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
