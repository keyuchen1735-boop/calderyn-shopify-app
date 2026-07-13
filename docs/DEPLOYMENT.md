# Deployment & Pending Manual Steps

Operational steps that are **not** done by merging code — someone has to run them
in Supabase / Vercel / the provider dashboards. Check items off (or delete them)
once done so we don't repeat or forget them.

---

## ⚠️ Pending — Shipping route-map destination repair

This rollout is **schema-first**: the app reads and writes the destination-repair
columns added by the migration below, while Supabase migrations are applied manually.

- [ ] **Before deploying the app**, apply `supabase/migrations/20260713160000_order_destination_repair.sql`
      to the target Supabase project with `supabase db push` (or `supabase migration up`),
      and confirm the migration is recorded as applied. Only then deploy the app.
      Deploying the app first will make the destination-repair cron and current
      webhook/backfill order writes fail on missing columns.

---

## ⚠️ Pending — Meta campaign actions (pause/resume)

Shipped in code on `main` (spec: `docs/superpowers/specs/2026-06-01-meta-campaign-actions-design.md`,
plan: `docs/superpowers/plans/2026-06-01-meta-campaign-actions.md`). The feature
will not work in a live shop until these are done:

- [ ] **Apply the Supabase migration** `supabase/migrations/20260601010000_integration_credentials.sql`
      (stores the encrypted Meta OAuth token). Run `supabase db push` (or `supabase migration up`)
      against the linked project. Verify the `public.integration_credentials` table exists.
- [ ] **Set env vars** (local `.env` + Vercel project):
  - `META_APP_ID`, `META_APP_SECRET` — a Meta developer app. **Development mode is
    enough to test pause/resume on your own ad account — no App Review needed.**
    (App Review for `ads_management` is only required to manage *other* merchants'
    accounts in production.)
  - `INTEGRATION_ENCRYPTION_KEY` — 32-byte key as 64 hex chars (e.g.
    `openssl rand -hex 32`). Rotating it invalidates all stored Meta tokens.
- [ ] **Register the OAuth redirect URI** `https://<app-url>/auth/meta` as a valid
      OAuth redirect in the Meta app settings.
- [ ] **Live end-to-end check** (plan Task 10 / Task 14 has the full steps):
      open the app → Settings → Connect Meta → complete OAuth → confirm a row in
      `integration_credentials` and `shop_integrations(kind=meta_ads, sync_status=ready)`
      → Campaigns page lists your live Meta campaigns → Pause one → confirm it shows
      `PAUSED` in Meta Ads Manager and an `action_audit` row was written → Undo →
      confirm it returns to its prior status in Meta.

---

## Reference

- Supabase migrations are **not** Prisma-managed (Prisma only owns `shopify_sessions`).
  Apply them via Supabase tooling, not `prisma migrate`. See the spec's schema section.
- When adding a new env var, also update `.env.example` (CLAUDE.md rule) **and** add
  a pending item here if it needs to be set in Vercel.
