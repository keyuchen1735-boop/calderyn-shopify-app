# Spec — Ad Creative Pre-Screen, Increment A: push a variant to Meta as a PAUSED draft

**Date:** 2026-06-09 · **Module:** `app/lib/screener/` · **Branch:** `feat/screener-meta-push` (off `origin/main`)

## Goal

Close the screener loop: let the merchant take a winning generated variant and create it in
their Meta account as a **PAUSED** ad in the source ad's ad set — never live, always behind an
explicit confirm, audited, and idempotent (no double-push).

## Constraints / decisions

- **Meta-sourced runs only.** A push needs the source ad's ad set + Facebook Page, so it's
  allowed only when `run.source === "meta_ad"` and `run.metaAdId` is set. Manual runs are rejected
  with a clear message.
- **No image upload.** Meta `link_data` accepts a `picture` URL instead of an `image_hash`, so we
  pass `variant.input.imageUrl` directly — works for both copy variants (source image preserved)
  and image variants (new Higgsfield URL). No `/adimages` upload, no hash fetch.
- **Always PAUSED.** The created ad is `status: "PAUSED"`. The human reviews/activates it in Meta
  Ads Manager. We never publish.
- **Audited + idempotent** via the existing `action_audit` / `action_idempotency` tables (one
  audit log for all merchant actions). Adds an `action_kind` enum value `push_creative`. The
  idempotency key `screener_push:{runId}:{variantIndex}` makes a re-push return the existing ad id
  instead of creating a duplicate.

## Flow

Route `action` (`intent=push`, `variantIndex`) → `metaClientForShop(shop)` → `pushVariantToMeta`:

1. Guard: meta-sourced run + valid variant, else error DTO.
2. Idempotency: if `action_idempotency` already has the key, return the prior audit's `post_state.ad_id`
   (`alreadyPushed: true`) — no Meta calls.
3. `GET /{metaAdId}?fields=adset{id},creative{object_story_spec}` → source `adset_id` + `page_id`.
4. `POST /{adAccountId}/adcreatives` with `object_story_spec = { page_id, link_data: { message,
   name, link, picture, call_to_action } }` → `creative_id`.
5. `POST /{adAccountId}/ads` with `{ adset_id, creative: {creative_id}, status: "PAUSED", name }`
   → new ad id.
6. Insert `action_audit` (`action_kind: 'push_creative'`, `post_state: { ad_id, creative_id }`,
   `outcome: 'succeeded'`) + `action_idempotency` row.
7. Return `{ ok: true, adId, alreadyPushed: false }`. **Never throws** — Meta/DB failure → error DTO
   (surfaced in the UI banner, rule 12).

Field shapes (`object_story_spec`, `adset{id}`, `picture`) are **VERIFY** against Graph v21.0 at
first live call; the Meta client is injected so tests fake it (no live calls).

## Module — `app/lib/screener/meta-push.server.ts`

- `pushIdempotencyKey(runId, variantIndex): string` — pure.
- `buildCreativeParams(name, input, pageId): Record<string,string>` — pure; builds the
  `adcreatives` body (nested `object_story_spec` JSON-stringified; `picture` only when imageUrl set).
- `pushVariantToMeta({ shop, run, variantIndex }, deps: { client: MetaClient; adAccountId: string })
  : Promise<PushResult>` — orchestrator above. `PushResult = { ok; adId: string|null; alreadyPushed;
  error: string|null }`.

## Route — `app/routes/app.screener.tsx`

New `intent === "push"` branch: read `variantIndex`, `getLatestRun(shop)`, `metaClientForShop(shop)`
(→ "connect Meta" error if null), call `pushVariantToMeta`, return `{ push: PushResult }`.

## UI

A dedicated second `useFetcher` (so push status never clobbers the run display). Per variant —
only when `run.source === "meta_ad"` — a **"Push to Meta (paused)"** button that opens one shared
Polaris confirm `Modal`; confirming submits the push form for that variant index. A `Banner` shows
the result: success (`"Created a paused ad ({adId}) — review it in Meta Ads Manager"`) or the error.

## Data model

Migration `..._action_kind_push_creative.sql` (+ byte-identical mirror in
`tests/engine/schema/migrations/`): `alter type action_kind add value if not exists 'push_creative';`
No new table; reuses `action_audit` / `action_idempotency`.

## Testing (no live calls)

- `buildCreativeParams`: nested `object_story_spec` JSON shape; `picture` present/absent by imageUrl;
  copy/cta mapped. `pushIdempotencyKey`: deterministic.
- `pushVariantToMeta` with a fake `MetaClient` + the Supabase chain mock: happy path (GET source →
  POST adcreatives → POST ads PAUSED → audit + idempotency rows; returns adId); idempotent replay
  (no Meta calls, returns existing adId); guards (manual run, bad index); Meta error → error DTO.

## Out of scope

Activating ads (always PAUSED); editing/deleting pushed ads; undo; video; pushing from non-latest
runs. Migration application to prod Supabase is a deploy step.

## Verification gate

`npx vitest run` · `npm run typecheck` · `npm run lint` (0 warnings touched) · `npm run build` —
green with evidence before commit. Then a polish pass + re-verify (per the user's request).
