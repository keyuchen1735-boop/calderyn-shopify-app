# Social digest: Approve / Reject / Regenerate + LinkedIn auto-post

**Status:** Design approved (brainstorming), pending spec review → implementation plan.
**Date:** 2026-06-17
**Builds on:** `cron/social-digest` (PR #151) — the weekly LinkedIn + Instagram carousel email.

## Problem

The weekly social-digest email (Fri 10:00 ET) currently delivers ready-to-post
carousels + captions as attachments. The founders want a decision loop in the
email itself:

- **Reject** → regenerate a *new* set of slides + captions and re-email immediately.
- **Approve** → post the LinkedIn carousel automatically; stage the Instagram
  carousel for a manual post (Instagram's API cannot publish from a personal
  account).

## Hard constraints discovered (why the design looks the way it does)

1. **Instagram can't be auto-posted.** Meta's Content Publishing API only works
   for Business/Creator accounts linked to a Facebook Page. The Calderyn IG is a
   personal account → **IG is manual-stage**, not auto-post. (Converting to a
   free Business account later unlocks auto-post; out of scope here.)
2. **LinkedIn needs an app.** There is no credentials-only API path. Posting to a
   *personal* profile requires a LinkedIn developer app with the self-serve
   **"Share on LinkedIn"** product (`w_member_social`) + a one-time member OAuth.
   "Personal" avoids the multi-week *company-page* review, not the app itself.
3. **Email buttons are links, and link scanners pre-fetch them.** Gmail/Outlook
   bots issue `GET` on links in email. So action links must be **idempotent on
   GET** (show a confirmation page) and perform the mutation only on an explicit
   **POST** from that page. Tokens must be single-use + expiring.
4. **Posting needs the image bytes after the fact.** Approve/reject happen long
   after the cron rendered the slides, so we must **store the rendered PNGs**
   (not re-render chromium on every click).

## Scope

**Phase 1 (this spec — no external approvals required):**
- Persist each weekly drop + its rendered images.
- Approve / Reject signed links in the email.
- Reject → reason chips (+ optional note) → regenerate (varied, excludes prior
  copy) → re-email. Cap 5 regenerations per drop.
- Approve → confirmation page that (a) auto-posts LinkedIn **if a token is
  connected**, (b) always presents the IG carousel + caption for one manual post.
- LinkedIn connector built but dormant until a token exists.

**Phase 2 (follow-up, gated on you creating the LinkedIn app):**
- LinkedIn OAuth connect flow + token storage/refresh → flips LinkedIn approve
  from "staged" to real auto-post. No code change to the rest of the system.

**Out of scope:** Instagram auto-post; company-page posting; scheduling/editing
slides in a UI; multi-tenant (this is Calderyn's own internal tool).

## Architecture

### Components (each independently testable)

1. **`social_digest` table** (Postgres/Supabase) — state for one drop.
2. **Image store** (`lib/social-digest/store.server.ts`) — write the 8 rendered
   PNGs to a private Supabase Storage bucket `social-digest/<id>/{li,ig}-N.png`;
   read bytes (LinkedIn) and mint signed URLs (email previews, IG download).
3. **Action tokens** (`lib/social-digest/token.server.ts`) — `sign(id, action,
   version)` / `verify(token)` using HMAC-SHA256 over `id|action|version|exp`
   with a server secret (`SOCIAL_ACTION_SECRET`, fallback `CRON_SECRET`).
   `version` = the row's `regen_count` at send time, so **each regeneration round
   invalidates the previous round's links** (a regenerated drop re-emails fresh
   tokens at the new version). Single-use within a version via `consumed_at`,
   which is **cleared when `regen_count` is bumped**.
4. **Review routes** (`routes/social.review.$id.tsx`):
   - `loader` (GET) — verify token, render the confirmation/result UI. **No
     mutation.** Safe for link pre-fetch.
   - `action` (POST) — perform approve / reject+regenerate; mark token consumed.
5. **Regenerate** (`lib/social-digest/run.server.ts`, extended) — `buildSocialPack`
   gains a `variation` input (reasons[], note, prior copy to avoid, higher temp).
6. **LinkedIn connector** (`lib/social/linkedin.server.ts`, Phase 1 dormant) —
   `postMultiImage({ token, authorUrn, caption, images })`: register upload →
   PUT each PNG → create the multi-image post; surfaces `userErrors`.
7. **Cron change** (`cron.social-digest`) — after render: store images, insert the
   `social_digest` row (status `pending`), and send the email with Approve/Reject
   links (previews via signed URLs).

### Data model — `social_digest`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `week_range` | text | "June 13–19, 2026" |
| `since_iso` | timestamptz | data window start |
| `status` | text | `pending` \| `regenerating` \| `posted` \| `failed` |
| `regen_count` | int | capped at 5 |
| `pack_json` | jsonb | the SocialPack (copy) |
| `li_image_paths` | text[] | storage keys, 4 |
| `ig_image_paths` | text[] | storage keys, 4 |
| `li_caption` | text | |
| `ig_caption` | text | |
| `prior_copy_json` | jsonb | accumulated rejected copy, to avoid repeats |
| `post_results_json` | jsonb | LinkedIn post id / errors, IG = manual |
| `consumed_at` | timestamptz | single-use guard for the current version; cleared on regen |
| `created_at` / `acted_at` | timestamptz | |

(No `acted_by`: all three recipients share one link per action, so we can't
attribute the click — and for an internal 3-person tool it doesn't matter.)

### Flows

**Cron (weekly):** generate pack → render 8 PNGs → store → insert row `pending` →
email with inline previews (signed URLs) + **Approve** and **Reject** buttons
(signed links to `/social/review/<id>?t=…&a=approve|reject`).

**Reject:** GET link → page with reason chips (tone too salesy / wrong feature /
weak visuals / bad captions) + optional note → POST → status `regenerating` →
append current copy to `prior_copy_json` → `buildSocialPack` with the variation
inputs → re-render → re-store → bump `regen_count` → re-email (new tokens) →
"regenerating, new email on its way" page. If `regen_count >= 5`: skip regen,
email says "latest version — edit/post manually."

**Approve:** GET link → confirmation page ("Post LinkedIn now + get IG assets")
→ POST →
- LinkedIn: if a connected token exists → `postMultiImage` the 4 LI slides +
  `li_caption`; record post id or error. If no token / expired → mark
  `li: staged` and tell the user to connect or post manually.
- Instagram: always staged — page shows the 4 IG slides (download) + caption
  (copy button).
- status → `posted` (LinkedIn done or staged) and result page shows outcome +
  any errors. **Never reports success on a failed post (rule 12).**

### Safety, limits, failure handling

- **Tokens:** HMAC-signed, action-scoped, 7-day expiry, single-use
  (`consumed_at`). Tampered/expired/replayed → 410 page with "request a fresh
  email."
- **Prefetch-proof:** GET never mutates; POST (form button) does.
- **Regen cap = 5/drop**, enforced in code (rule 5), surfaced to the user when hit.
- **LinkedIn failures** (auth, `userErrors`, rate limit) → shown on the result
  page with the assets to post manually; status reflects reality.
- **Idempotency:** once `consumed_at` is set, re-POST is a no-op showing the
  prior result (handles double-submit / retried links).

### Env / config additions

- `SOCIAL_ACTION_SECRET` (HMAC; fallback to `CRON_SECRET`).
- Supabase Storage bucket `social-digest` (private).
- Phase 2 only: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
  `LINKEDIN_REDIRECT_URI`; token row stored per connected member.

### Testing (behavior, not mocks-of-everything)

- `token.server`: sign→verify round trip; reject tampered sig, expired, replayed.
- regenerate: variation prompt includes reasons/note + excludes prior copy; cap
  enforced at 5; `prior_copy_json` accumulates.
- review state machine: `pending`→approve→`posted`; `pending`→reject→
  `regenerating`→`pending`; consumed token → idempotent no-op.
- `linkedin.server`: mock the 3-step upload+post; assert request shapes and that
  `userErrors` propagate (no silent success).

### Phase 2 prerequisite (LinkedIn app — your one manual step)

1. Create a free app at linkedin.com/developers (your personal account).
2. Add products: **"Sign In with LinkedIn using OpenID Connect"** (member id) +
   **"Share on LinkedIn"** (`w_member_social`) — both self-serve.
3. Set the redirect URI to `https://app.calderyncompany.com/social/linkedin/callback`.
4. Put client id/secret in Vercel env; click "Connect LinkedIn" once in-app.

## Open question for review

- **Image storage:** spec assumes **Supabase Storage** (app already on Supabase).
  Alternative is Vercel Blob. Confirm Supabase is fine.
