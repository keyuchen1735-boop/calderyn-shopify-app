# Slice 0 — First-Party Auth (De-Shopify the Login)

**Date:** 2026-06-28
**Status:** Design approved (brainstorm). Ready for spec review → implementation plan.
**Parent:** [Calderyn Platform Pivot — Build Map](./2026-06-27-calderyn-platform-pivot-design.md). This is **Slice 0**, the closest-to-done, zero-dependency enabler that everything else hangs off of.

---

## Goal

A merchant can log into Calderyn **without a Shopify store**. Today the only way into the Calderyn admin is through Shopify (install the embedded app → Shopify OAuth proves who you are → a session is minted keyed to the `*.myshopify.com` domain). Slice 0 introduces a first-party login and decouples the tenant key from the Shopify domain, so a store can exist and be operated with Shopify never involved.

Slice 0 is **done** when a brand-new person can sign up with email + password, log in at `app.calderyncompany.com`, and land on their (empty) store dashboard — no Shopify in the loop.

---

## Decisions (locked in brainstorm)

| Decision | Choice | Notes |
|---|---|---|
| Front doors | **Both** | Shopify-connect (Door A) + fresh signup (Door B). |
| Login method | **Email + password now** | Google sign-in (OAuth) saved for later; magic link dropped. |
| Account ↔ store model | **Multi-store-ready data model, one-store UI for v1** | One login *can* hold many stores in the schema; the UI shows one store and adds no store-picker yet. Matches Shopify's end state (one account → many stores via a store picker) without the v1 cross-store-leak risk. |
| "Connect Shopify" | **One shared capability, not a separate door** | Auto-runs during Door A; an optional button in the dashboard for Door B. Built once, both doors use it. |

---

## The shape

There is **one login system** and **one "connect Shopify" action**. The two doors differ only in *when* the Shopify connect happens.

```
Door A (start in Shopify):
  embedded app (already Shopify-authed) → "Connect to Calderyn"
      → provision first-party account from the Shopify store email
      → email a "set your password" link
      → dashboard (their already-mirrored data shows)

Door B (start fresh):
  app.calderyncompany.com → sign up (email + password) → dashboard (empty store)
      → optional "Connect Shopify" button:
            • click → start mirroring their Shopify store
            • skip  → keep an empty store
```

| Piece | What it is |
|---|---|
| One login | email + password (used by both doors) |
| One "Connect Shopify" action | auto in Door A; optional dashboard button in Door B |
| Difference between doors | *when* the connect happens — during signup (A) vs later, on demand (B) |

---

## Scope boundary — what "Connect Shopify" delivers *at Slice 0*

Important honesty point: the owned catalog / inventory / checkout do **not** exist yet (those are Slices 1–3). So at Slice 0, "Connect Shopify" cannot perform the full "run your store ON Calderyn" migration. It does exactly two things, both reusing infrastructure that already exists:

- **Door A:** the embedded app already mirrors Shopify catalog/inventory/orders/ads into the warehouse today. Connect = create a first-party `users` account tied to that **existing** `shops` row + set a password. The merchant gets a direct login; their already-mirrored data is already visible in the dashboard.
- **Door B:** a fresh first-party account initiates the **existing** Shopify OAuth + mirror ingest from a logged-in context (instead of from app install). Data starts flowing into the warehouse as it does today.

The **same button** delivers more as later slices land (Slice 9 / `#13.promote` turns the mirror into an owned source-of-truth). Slice 0 just establishes *account + link + login* — it does not build the owned-store migration. Do not oversell the button.

---

## Data model / contracts

**New tables**
- `users` — `id uuid pk`, `email citext unique`, `password_hash text` (argon2id or bcrypt), `created_at`, `updated_at`. (Nullable-credential columns left open for the later Google/OAuth path; not added now — YAGNI.)
- `membership` — `user_id → users`, `shop_id → shops`, `role text` (`owner` for v1), `created_at`; `unique(user_id, shop_id)`. This is the multi-store-ready link; v1 always has exactly one row per user.

**Changed tables**
- `shops` — ADD owned identity columns: `org_slug text unique`, `display_name text`, `custom_domain text null`, `billing_customer_id text null`. Make `shop_domain` **nullable** (legacy/import-map, no longer the required unique key).
- `dashboard_sessions` — ADD `user_id` (keep `shop_id` for existing `.eq` scoping during transition).

**Changed code seams**
- `app/lib/supabase.server.ts` — `resolveShopId(shopDomain)` → `resolveShopId(ownedKey)`; `provisionShop(shopDomain)` → `provisionOrg(...)`; re-key `shopIdCache` from domain to the owned id. **The `shops.id` UUID contract is unchanged** — every downstream `*_fact` / `*_dim` table and `v_*` view that filters on `shop_id` is untouched. This is why the slice is cheap.
- `app/lib/dashboard/session.server.ts` — `createSession(shopDomain)` → `createSession(userId)`; `DashboardSession` becomes `{ userId, orgId, shopId }` (still carries `shopId` for downstream scoping). Token mint/hash/validate/slide/revoke, the `__Host-` cookie, the pepper, and the 30-day sliding TTL are **unchanged**. `revokeAllSessionsForShop` → generalized to `revokeAllSessionsForUser`.
- `app/routes/dashboard.login.tsx` + `dashboard.auth.callback.tsx` — replace the Shopify code-exchange bounce with the first-party email+password form + verification. New routes for signup, set-password (Door A), and password reset.

**Reused as-is**
- Email sending: `app/lib/email/send.server.ts` (covers set-password + reset emails).
- The existing postgres rate limiter (harden the new login/signup/reset routes with it).
- The existing Shopify OAuth + mirror ingest (Door A is already authed; Door B triggers the same connect).

---

## What stays safe (transition strategy)

**Dual-run. Nothing is ripped out in Slice 0.**
- The embedded Shopify app and all existing demo stores (showcase, calderyn-test, review-store) keep working exactly as now.
- We **add** the first-party login next to the Shopify path; the Shopify-domain lookup keeps resolving via the now-nullable `shop_domain` column.
- Retiring the embedded Polaris admin is explicitly **later**, not Slice 0.

---

## Security considerations (net-new attack surface)

Email+password is the most security work of the options we considered; these are required, not optional:
- **Password storage:** scrypt via `node:crypto` (no new dependency), cost tuned to ~50–100 ms (**N ≥ 2^16**); argon2id is the stronger option if a dependency is acceptable. Never plaintext, never reversible.
- **Password pepper (defense-in-depth):** HMAC each password with a **server-side secret** (`PASSWORD_PEPPER`, a new env — add to `.env.example`) BEFORE the scrypt hash, so a **database-only leak can't be cracked** without the separate secret. Same idea as the session pepper.
- **Reset flow:** single-use, short-TTL (1h), hashed-at-rest reset tokens (the opaque-token + HMAC pattern the session already uses). On a successful reset, **revoke ALL of the user's sessions** — a stolen/forgotten session is killed by the reset.
- **Rate limiting — TWO layers:** per-IP **and per-account** on login / signup / reset / set-password. Per-IP alone is bypassed by IP rotation; a per-account throttle + temporary lockout after repeated failures stops credential-stuffing a single account.
- **Account enumeration:** login + reset responses are uniform (no "email exists" signal); a dummy hash runs even when the email is unknown so timing doesn't leak.
- **Email verification:** signup sends a verification link; the account is flagged unverified until confirmed, so nobody can sign up under someone else's email and use it for sensitive actions.
- **Reset-link leakage:** the reset / set-password pages send `Referrer-Policy: no-referrer` and load no third-party resources, so the token in the URL can't leak via the `Referer` header.
- **Set-password (Door A):** single-use, short-TTL link emailed to the Shopify store email; do not auto-set a known password.
- **Hygiene:** never log passwords, tokens, or hashes; keep the `__Host-` + `Secure` + `SameSite=Lax` cookie and the `requireSameOrigin` CSRF guard.

---

## Out of scope (deferred, on purpose)

- Google sign-in / OAuth login (fast-follow).
- Magic-link login (dropped).
- Multi-store **UI** — the store picker and "which store am I viewing" switcher (schema is ready; UI is later).
- Retiring the embedded Polaris admin.
- The full mirror→owned **migration/promote** (Slice 9 / `#13.promote`). Slice 0's connect only establishes account + link + login.
- Buyer-side accounts (buyers are guest-checkout in a much later slice; this is merchant/operator auth only).

---

## Success criteria

1. A new person signs up at `app.calderyncompany.com` with email + password, logs in, and reaches an empty store dashboard — **no Shopify involved**.
2. A merchant in the embedded app clicks "Connect to Calderyn," receives a set-password email, sets a password, and can thereafter log in directly at `app.calderyncompany.com` and see their already-mirrored data.
3. A logged-in fresh merchant clicks "Connect Shopify," completes Shopify OAuth, and their store begins mirroring.
4. All existing Shopify-keyed demo stores still resolve and work (dual-run intact).
5. New login/signup/reset/set-password routes are rate-limited and do not leak account existence.

---

## Risks (carried from the pivot spec)

- **Identity-migration blast radius.** `shop_domain` is read widely (every loader, MCP token path, `isShowcaseShop`, validators, `dashboard_sessions`). Re-keying must be total or a stale domain-keyed cache entry resolves the wrong tenant. The repo has had cross-tenant id bugs before — audit every `.myshopify.com`-derived assumption.
- **`shopIdCache` correctness.** The per-process memo (supabase.server.ts) must re-key atomically; a mixed domain/owned-id cache leaks tenants.
- **Nullable `shop_domain`.** It is currently treated as a required unique key (provisionShop onConflict, dashboard_sessions, validators). Making it nullable without finding every NOT-NULL/uniqueness assumption risks provisioning failures.
- **`session.shopDomain` readers.** Every caller of `getSessionFromRequest` that reads `session.shopDomain` assumes 1 session = 1 shop; the user→shop move touches all of them, not just the auth route.

---

## Next step

User reviews this spec → then invoke `writing-plans` to produce the step-by-step implementation plan. Build in an isolated worktree (`feat/de-shopify-auth`) per the repo's feature-isolation rule. Dashboard parity is part of the slice, not a follow-up.
