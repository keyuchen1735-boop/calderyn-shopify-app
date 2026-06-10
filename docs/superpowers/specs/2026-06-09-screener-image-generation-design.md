# Spec — Ad Creative Pre-Screen, Plan 4 (image-first): Higgsfield image generation

**Date:** 2026-06-09 · **Module:** `app/lib/screener/` · **Branch:** `feat/screener-image-gen` (off `origin/main`)

## Goal

The screener can already regenerate ad **copy** and re-score it (Plan 3). This adds a second
generator mode — **image** — that produces a new ad image via Higgsfield, conditioned on the
creative's weak dimensions, and runs it through the **same re-score gate** so only images that
beat the original are shown. Anti-slop guarantee holds for images (the scorer's Claude-vision
path scores the new `imageUrl` directly). **Video is out of scope** — it needs async job infra
*and* an unresolved video-scoring strategy.

## Decision: synchronous, image-first

Higgsfield generation is async (submit → poll) but images finish in ~15s, and the official
client exposes a synchronous "subscribe" (submit-and-wait; 0.5s poll, 90s budget). The existing
generate action already makes ~5 sequential Claude calls, so one synchronous image (count = 1)
+ its re-score sits in the same runtime envelope — **no new job table / cron / status route.**
Caveat: this route must not set `maxDuration` (§5 of handoff), so image mode is capped at 1
candidate. If latency proves too high we escalate to an async job model (also what video needs).

## Higgsfield REST contract (verified against the official client, 2026-06-09)

- Base URL `https://platform.higgsfield.ai`.
- Auth header `Authorization: Key {key}:{secret}` — from `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET`.
- Submit: `POST {base}/{model_path}` with JSON `{ prompt, aspect_ratio, resolution, ... }` →
  response carries `request_id`.
- Poll: `GET {base}/requests/{request_id}/status` → `{ status, ... }`; terminal statuses
  `completed | nsfw | cancelled | failed`; on `completed` the payload carries `images[0].url`.
- Model: `marketing_studio_image` (product/ad image model; accepts a reference image). The exact
  reference-image field name + model path string are **VERIFY** at first live call (encapsulated
  in one HTTP fn; tests fake it, so the architecture does not depend on them).

## Design

**New file `app/lib/screener/higgsfield.server.ts`:**

- `imageGenerator(deps): CreativeGenerator` —
  - `mode: "image"`, `available: () => !!process.env.HIGGSFIELD_API_KEY && !!process.env.HIGGSFIELD_API_SECRET`.
  - `generate(req)`: build an image prompt from `req.weakMetrics` + `req.tips` + `req.styleRefs`,
    call the DI'd `generateImage` with the original `req.input.imageUrl` as the reference, and
    map each returned asset URL to a `GeneratedCandidate` whose `input` is the original creative
    with **only `imageUrl` swapped** (copy/destination/audience preserved — inverse of `copyGenerator`).
- `GenerateImageFn` (DI seam, faked in tests): `(args: { prompt; referenceImageUrl: string|null; count }) => Promise<string[]>` (asset URLs).
- `higgsfieldImageClient()`: real impl of `GenerateImageFn` — submit `POST /{model}`, then poll
  `GET /requests/{id}/status` to terminal, return `images[].url`; auth header from env; mirrors
  the Meta client's fetch-wrap + throw-on-error (`app/lib/meta/client.server.ts`).

**Route `app/routes/app.screener.tsx`:** replace the hardcoded `copyGenerator` in the
`intent === "generate"` branch with `pickGenerator(form.get("mode"), { createMessage, model })`
returning `copyGenerator` ("copy", default) or `imageGenerator` ("image"). `generateImprovements`
and `scoreOne` are unchanged; if `available()` is false the existing `{ available: false }` path
already drives the UI.

**UI:** a Copy/Image segmented control on the generate card; when image is unavailable, render
"Connect image generation (set HIGGSFIELD_API_KEY)" instead of the button.

**Types / data:** none new — `CreativeInput.imageUrl` already exists; no migration. No `videoUrl`.

**Env:** add `HIGGSFIELD_API_KEY` and `HIGGSFIELD_API_SECRET` to `.env.example` (server-only).

## Testing (no live calls)

- `imageGenerator` with a fake `GenerateImageFn`: prompt built from weak dims/tips/styleRefs;
  `available()` true only when both env vars set, false otherwise; returned URLs become candidates
  with image swapped + copy preserved; empty/failed generation → no candidates.
- The re-score gate (`generateImprovements`) still drops a regression: fake a generated image
  that the fake scorer rates below baseline → discarded.
- Route factory `pickGenerator` (pure, exported): "image" → image mode, default → copy.

## Out of scope

Video generation; async job/cron infra; pushing a chosen variant to Meta (Increment A); any
change to the copy generator or the scorer.

## Verification gate

`npx vitest run` · `npm run typecheck` · `npm run lint` (0 warnings on touched files) ·
`npm run build` — all green with evidence before commit (CLAUDE.md pre-commit gate). Ships
gated-off (no key) until the human provides Higgsfield credentials and the live field shapes are
verified.
