# Spec — Image-generation cost guardrails

**Date:** 2026-06-10 · **Module:** `app/lib/screener/` · **Branch:** `feat/image-gen-cost-guardrails` (off `origin/main`)

## Goal

Image generation uses **one shared Higgsfield account** (app-level key, like the Anthropic
assistant), so every merchant's generations bill to us. Bound the spend so a busy or abusive
merchant — or a flood of them — can't run up a surprise bill. Copy generation (Anthropic) is
unaffected; this targets the paid image path only.

## Three layers

1. **Per-click cap = 1 image.** The generate action defaults to 3 candidates; for `mode === "image"`
   it now requests **1**. (Copy stays at the default.)
2. **Per-merchant daily limit.** A shop may generate `IMAGE_GEN_DAILY_PER_SHOP` images/day
   (default **20**). Over → friendly "daily limit reached, resets tomorrow" message, **no Higgsfield call**.
3. **Global daily backstop.** A hard ceiling of `IMAGE_GEN_DAILY_GLOBAL` images/day across **all**
   shops (default **300**). This is the absolute cap — max daily spend = `GLOBAL × per-image cost`,
   regardless of merchant count or abuse.

All three are **env-tunable** (no code change to adjust): `IMAGE_GEN_DAILY_PER_SHOP`,
`IMAGE_GEN_DAILY_GLOBAL`.

## Security (verified in build)

- **Auth:** the screener route already gates on `authenticate.admin` — only signed-in app merchants reach it.
- **Secrets server-only:** key + secret read from `process.env` in `.server` modules; never in the client bundle.
- **Shop-scoped + RLS:** the usage table has RLS enabled (deny-by-default; app uses the service role,
  matching the other screener tables). Counting + reservation happen server-side, in the action,
  **before** any Higgsfield call.

## Data model

Migration `20260610120000_image_gen_event.sql` (+ byte-identical mirror in
`tests/engine/schema/migrations/`): one row per generated image.

```sql
create table image_gen_event (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now()
);
-- indexes on (day) and (shop_id, day); RLS enabled, deny-by-default.
```

Row-count per day is the counter (avoids non-atomic `count+1` upserts). A blocked attempt inserts
**nothing**, so blocked spam can't inflate the global counter and starve other shops.

## Module — `app/lib/screener/image-gen-limit.server.ts`

- `imageGenLimits(): { perShopDaily; globalDaily }` — from env, with defaults 20 / 300.
- `decideImageGenLimit({ shopCount, globalCount, perShopDaily, globalDaily }): { ok; scope?; limit? }`
  — **pure**; per-shop checked first, then global.
- `checkAndReserveImageGen(shop, now?): Promise<ReserveResult>` — resolves shop, counts today's
  per-shop + global rows (UTC day; `now` injectable for tests), decides, and **inserts one event
  only when allowed**. Returns `{ ok: true; remaining }` or `{ ok: false; scope; limit }`. Never throws.

## Route — `app/routes/app.screener.tsx`

In the `generate` branch: when the requested mode is `image`, call `checkAndReserveImageGen(shop)`
first — if blocked, return `{ generateError: "<friendly limit message>" }` and skip generation;
otherwise call `generateImprovements` with `count: 1`. Copy mode is untouched (no reservation, default count).

## UI

The limit message rides the existing generate-error banner — no new surface. (A remaining-today
indicator is a possible follow-up; out of scope here.)

## Testing (no live calls)

- `decideImageGenLimit` pure: under both limits → ok; per-shop at limit → `scope: "shop"`;
  global at limit → `scope: "global"`; per-shop precedence when both exceeded.
- `checkAndReserveImageGen` over the Supabase chain mock: counts queried with shop+day / day filters;
  under limit → event inserted + `ok`; at per-shop limit → no insert, `scope: "shop"`; at global
  limit → no insert, `scope: "global"`.
- `imageGenLimits` reads env overrides + falls back to defaults.

## Out of scope

Refunding a slot on a failed Higgsfield call; per-merchant Higgsfield keys; remaining-today UI;
old-row cleanup cron. Limits apply to image gen only (copy unaffected).

## Verification gate

`npx vitest run` · `npm run typecheck` · `npm run lint` (0 on touched files) · `npm run build` —
green with evidence, then a polish pass + re-verify, before commit/PR.
