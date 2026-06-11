# Creative Predictor — mandatory media drop box (image/video) — design

**Date:** 2026-06-11. **Status:** approved-by-default (autonomous session; assumptions listed in §7).
**Ask:** "on creative predictor for both dash and extension I need a drop in box for a video or image of the actual creative (mandatory) to be evaled."

## 1. Problem

The predictor scores creatives, but the manual path only takes an optional image *URL* — most merchants
have a file, not a hosted URL, and video creatives can't be provided at all. The score is supposed to be
about the actual creative; today it can run on copy alone. Both surfaces need a drag-and-drop box for the
real media file, and the manual flow must refuse to score without it.

- **Extension** (`app/routes/app.screener.tsx`): live eval via `executeScreen`. Form has
  "Image link (optional)" TextField → replace with a mandatory Polaris DropZone.
- **Dashboard** (`app/components/dashboard/screens/Predictor.tsx`): screen is demo-only (simulated run,
  `TODO(other-agent): replace with live predictor API`). Gets the same mandatory drop box **and** live
  scoring via a new `dashboard.api.screener` endpoint, following the existing `dashboard.api.*`
  cookie-session pattern. (Both surfaces live in this repo — dashboard parity is satisfied in one change.)

## 2. Approaches considered

1. **Client-side processing → data URLs in the form post → base64 blocks to Claude** (CHOSEN).
   Image: downscale to ≤1280px WebP (~150–300KB) on a canvas — the exact pattern already proven in
   `app/components/dashboard/image-slot.tsx`. Video: extract 3 key frames (≈2%, 35%, 70% of duration)
   client-side via `<video>` + canvas; ship frames, not the file. No new infra, no env keys, no schema
   migration (media rides in the existing `creative_input` jsonb), payload stays well under Vercel's
   4.5MB body limit, and it solves the "Claude can't watch video" problem (handoff §8 decision #2) the
   way the handoff itself recommends — score frames as a proxy.
2. Supabase Storage bucket + signed-URL upload. Real asset persistence, but new bucket/policies/lifecycle,
   a two-step upload flow, and raw-video upload sizes — none of it needed for the eval itself. Rejected
   for scope (rule 2).
3. Multipart upload to the action + server-side processing. Server-side video decode needs ffmpeg, which
   the Remix serverless function doesn't have. Rejected.

## 3. Data contract

`CreativeInput` (in `app/lib/screener/types.ts`) gains optional fields — old persisted rows remain valid:

```ts
export type MediaKind = "image" | "video";
interface CreativeInput {
  imageUrl: string | null;        // image creative, or poster (first frame) for video; data: or https:
  mediaKind?: MediaKind | null;   // null/absent = legacy or Meta-sourced row
  videoFrameUrls?: string[];      // extracted frames (data URLs), video only
  videoDurationSec?: number | null;
  // ...existing copy fields unchanged
}
```

`imageUrl` doubling as the video poster keeps every existing consumer working unchanged: result-hero
`<img>`, copy generator (spreads `...req.input`), meta-push, list views (`listRuns` already omits
`creative_input`).

**Form/JSON contract (both surfaces):** `mediaKind`, `imageUrl` (data URL), `videoFrameUrls`
(JSON-encoded array), `videoDurationSec`.

## 4. Components

- **`app/lib/creative-media.ts`** (new, client-safe): `processCreativeMedia(file)` →
  `{ kind, imageUrl, frameUrls?, durationSec? }`. Accepts PNG/JPEG/WebP/AVIF images and MP4/WebM/MOV
  video; throws descriptive errors (undecodable codec, oversized file). Pure helpers
  (frame-timestamp math, type acceptance) are exported for unit tests; DOM work stays thin.
- **`app/lib/screener/score.server.ts`**: `buildUserContent` builds image blocks from data URLs
  (base64 source) or http URLs (url source). Video → text preamble ("Video creative, ~Ns; frames in
  order start→end") + one block per frame. System prompt mentions video frames.
- **`app/routes/app.screener.tsx`**: DropZone card replaces the URL field; submit disabled until media
  is processed; hidden inputs carry the contract. `parseCreativeForm` reads the new fields. New exported
  `validateCreativeMedia(input)` enforces mandatory media on the **manual** path server-side; failure
  returns `json({ formError })` rendered as a critical banner (form phase preserved).
- **`app/routes/dashboard.api.screener.tsx`** (new): `loader` → latest run; `action` (POST JSON) →
  validate media (same helper) → `executeScreen({ shop: session.shopDomain, ... })` → run DTO. Auth via
  `requireDashboardSession` + `dashboardJson`, exactly like `dashboard.api.overview`.
- **`app/lib/dashboard/client.ts`**: `screenCreative(payload)`, `fetchLatestScreenRun()`,
  `adaptRunToScorecard(run)` → existing `Scorecard` view-model.
- **`app/components/dashboard/MediaDrop.tsx`** (new): controlled React drop box in dashboard idiom
  (cd-* styles), click-to-browse + drag-drop, poster preview, remove button, inline error. NOT
  `image-slot` (that's a sidecar-persisting deck widget, wrong tool for a form input).
- **`app/components/dashboard/screens/Predictor.tsx`**: MediaDrop (mandatory) in the form; `run()` posts
  to the live endpoint while the staged animation plays; result phase renders the live scorecard (falls
  back to the demo SCORECARD only when no real run exists, preserving the current first-visit preview).
  On mount, the latest real run (if any) replaces the demo.

## 5. Mandatory-ness rules

- Manual path (both surfaces): no media → submit blocked client-side; server returns a form error
  (defense in depth — never trust FormData shapes).
- Meta-ad path: exempt. Meta *is* the actual creative; nothing to drop.
- Generate/copy-variant path: untouched; `...req.input` spread preserves media fields on variants.

## 6. Error handling & limits

- Undecodable video (e.g. HEVC .mov in some browsers) → inline error: "Couldn't read that video — use
  MP4 (H.264) or WebM." Oversized input (image >20MB, video >300MB) rejected before processing.
- 3 frames × ~300KB + poster ≈ ≤1.5MB form body — under the 4.5MB function limit; each base64 image is
  far under Claude's 5MB/image cap.
- Scoring failures keep flowing through `executeScreen`'s error-DTO path (rule 12).

## 7. Assumptions (flagged for the owner)

1. Frames-as-proxy is acceptable video eval (matches handoff §8 recommendation); the raw video file is
   not persisted anywhere.
2. The optional "Image link" URL field is removed — the drop box replaces it (the ask said mandatory
   drop-in box). Meta picker still bypasses it.
3. Dashboard goes live for the *score* flow only; the demo "pick a live ad" list and generator stay
   simulated (their TODO stands).
4. No schema migration: media lives in `creative_input` jsonb (~0.2–1.2MB/run). List queries already
   exclude it.

## 8. Testing

- `score.test.ts`: data-URL → base64 block; video frames + preamble; http URL unchanged.
- `route-helpers.test.ts`: `parseCreativeForm` media fields; `validateCreativeMedia` accept/reject paths.
- `creative-media.test.ts`: pure helpers (frame timestamps, acceptance, size caps).
- Dashboard: `adaptRunToScorecard` mapping test.
- Gate: `npx vitest run`, `tsc --noEmit`, `npm run lint`, `npm run build` — all green before commit.
