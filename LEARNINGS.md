# Nightly maintenance — cross-night memory (LEARNINGS.md)

Long-lived brain for the unattended nightly run. Records false positives (do NOT
re-flag), recurring bug patterns, fixes that worked, and gate/CI gotchas.

## 2026-07-05

### Triage — ~40 commits (PRs #302–#309 + demo-showcase merge); a GENUINE companion nightly PR existed
Window = merged 2026-07-04 on `main` `89059ad`: signup onboarding (#305), demo showcase account +
resettable Peak & Pine shop, calibration prelock/hourly-recompute/too_aggressive rule writers (#302
region), SKU→dedicated-campaign autopilot (#302), Home redesign (#306–#309: agent-first landing,
progressive first-paint, prompt→chat handoff). Fanned out **4 read-only bug-hunters** by cluster
(onboarding/auth · demo/seed · calibration/autopilot money-path · Home/dashboard UI). 2 → NONE
(verified clean/hardened); 1 real bug found + fixed; 1 real-but-not-surgically-fixable finding surfaced.
Shipped **PR #311** (draft), branch `fix/nightly-2026-07-05`, single commit `5f2e0fd`.

- **Companion nightly PR #310 (author Mezoh, branch `nightly-review/2026-07-05`) was GENUINE this time**
  (base sha == our `main` `89059ad`; triage covered the real window — unlike #299 on 2026-07-04). It
  fixed 4 defects: demo-reset `sku_reorder_belief` (table has NO migration → PGRST205 wipe throw, breaks
  ALL demo-reset); `calibration/reject.server.ts` $0-impact cap flooring to 1¢ and bricking a pair;
  `dedicated-campaign.server.ts` empty/absent read returning 0 (fail-open) instead of null;
  `dashboard.store.preview.tsx` loader shipping the internal `shop_id` UUID to the browser. **Did NOT
  duplicate these** — reviewed all 4 (correct, well-scoped; guards both RPC + fallback cap paths;
  DTO-only preview) → posted NONE, and hunted for what #310 MISSED. Same playbook as 2026-07-03 with #273.

### Bug fixed tonight — decision-deck batch approve double-submits a reversible money action
- **`app/components/dashboard/screens/Dashboard.tsx`** (Home decision deck, landed via `2d4bdd6`/#306).
  A batch only starts when there is NO current card (`showBatch = !current && …`). But `approveBatch`
  dismisses items one-at-a-time INSIDE its loop (`setDismissed` after each `await executeAction`); each
  dismissal re-runs the fold `useMemo`, which unfolds the batch once `eligible.length < 2`. So on the
  PENULTIMATE dismissal the LAST still-in-flight item pops back out as `current = cardQueue[0]` and
  renders a full card with a LIVE Approve button (`approving` is null during a batch run — the batch
  tracks `batchLeft`, not `approving`), WHILE the loop is still awaiting that same item's executeAction.
  A merchant click → `executeAction(sameAlert, sameAction)` fires a 2nd time → the reversible money
  action (reduce_campaign_budget / pause_campaign) runs twice. Fix (one line): gate `current` on
  `batchLeft` — `const current = batchLeft !== null ? null : (cardQueue[0] ?? null)` — freezing the deck
  during a batch so no live single-approve card can leak. `approveBatch` was already re-entrancy-guarded;
  the batch button is already `disabled={batchLeft !== null}`. No test asserted the old behavior.
- **Lesson (loop-mutates-derived-state UI race):** when a sequential async loop calls a state setter
  (`setDismissed`) between awaits AND a `useMemo`/derived value keys off that state to decide what's
  interactive, each iteration re-derives mid-flight and can surface an item the loop is still processing
  as a fresh, clickable control → double-submit. Freeze the interactive surface for the loop's duration
  (guard on the in-progress flag) or batch the dismissals into a single post-loop setState.
- **Dashboard parity:** `app/components/dashboard/screens/*` IS the dashboard surface (rendered by
  `app/routes/dashboard.$.tsx`; per CLAUDE.md the repo's `dashboard.*` routes ARE the dashboard). So a
  fix here lands on the dashboard directly — there is NO separate mirror to update for these components.
  (A fixer subagent mis-flagged this as a parity TODO; it isn't one.)

### Found but NOT auto-fixed (surfaced for a product/maintainer decision) — do act on this if it recurs
- **`supabase/migrations/20260703200000_prelock_no_brainer_autonomy.sql`** (`9908ab3`/#302) re-enables
  the three no-brainer `pause_campaign` pairs for every row `where not autonomy_enabled and not
  merchant_disabled and not exists(muted_pair)`. But the Live-Engine off-switch (`setPairAutonomy` in
  `app/lib/calibration/live-engine.server.ts`) writes ONLY `autonomy_enabled`; **`merchant_disabled` is
  never set true by any current writer** (its sole write, `calderyn.server.ts:1573`, only clears it to
  false on unmute). So a merchant who enabled→disabled a no-brainer during the ~1-week Slice C window
  sits at `autonomy_enabled=false, merchant_disabled=false, no muted_pair` — which this migration flips
  back to true, silently resuming autonomous campaign pausing they turned OFF, on the money path. The
  migration header's "respects explicit merchant signals" is false for the ONE signal that is the
  off-switch. **Why not fixed:** it's a one-shot SQL migration already landed/applied — editing it does
  nothing on migrated DBs and violates repo migration-immutability; after the flip affected rows are
  indistinguishable from freshly-enabled, so no forward migration can identify/repair them. The LIVE seed
  path `seedShippedAutopilotFeatures` (`supabase.server.ts`) is SAFE — upserts with
  `ignoreDuplicates: true`, so re-auth does NOT re-flip merchant-off rows; only the historical one-shot
  migration bites. Documented in #311's "Attempted — unresolved" section for a maintainer call.
- **Lesson (boolean-default vs explicit-off collision):** a single boolean column can't distinguish
  "never set (schema default)" from "user explicitly turned off." Any backfill/seed that flips
  `false → true` on such a column reverts explicit opt-outs. When a feature adds a second-gate boolean
  (default false) that a UI toggle also writes, the safe backfill must key off a distinct opt-out marker
  or a nullable tri-state (`NULL`=never-set), NOT `not <flag>`.

### False positives cleared this run (do NOT re-flag)
- **Signup onboarding (#305):** `needsOnboarding = userId != null && onboardedAt == null` correctly
  exempts shop sessions (userId null); gate runs before verify in both `requireVerifiedSession` and
  `requireDashboardSession`; onboarding route loader is read-only + session-gated, action re-checks
  session/rejects shop sessions/rate-limits/validates FormData; `normalizePhone`/`isReferralSource`
  reject bad input without throwing; migration backfills `onboarded_at = now()` for pre-existing users
  (never retro-forced), new rows default NULL; `.select` includes `onboarded_at` (no snake↔camel gap).
- **Demo showcase / seed:** demo-reset derives shop only from `session.shopId` (no forgeable param),
  `requireSameOrigin` + rate-limit, `resetDemoShowcase` re-reads `shops.demo_mode` and throws
  `not_demo_shop` BEFORE any wipe (fail-closed); service-role client so no RLS silent no-op; every
  `SHOWCASE_WIPE_ORDER` table (except the #310-fixed `sku_reorder_belief`) exists in a migration or the
  vendored engine schema and carries `shop_id`; FK/wipe ordering children-before-parents, cascade-only
  tables intentionally omitted; seed enum/CHECK values valid, no future stamps, `variant_dim.id ==
  sku_dim.id` intentional (promote preserves id).
- **Calibration/autopilot (rest of cluster):** mu-override `min(policyMu, muOverride)` + `1-0.5·mu`
  strictly shrink; min_spend floor `spend+1` vetoes correctly; day-anchor recompute + cron status codes
  (502 shop-read, 500 real error, organic errors non-fatal) correct; SKU→dedicated-campaign shop-scoped,
  pause-only, fail-closed on unverifiable spend.
- **Home UI (rest):** boot generation guard (`loadGen` ref + `fresh()`) drops stale slices, no
  cross-tenant seed; prompt→chat handoff queue `n`-keyed, drained one-at-a-time, no drop/double-send;
  `live-engine-page.server.ts` displayTarget resolves from loaded rows (no N+1), unresolvable → "" with
  text fallback; TickGauge + motion effects hooks-order clean. (Known cosmetic, NOT fixed: `approveBatch`
  not bumping `handledSession` drifts the "X of Y" total — #310 flagged it, left intentionally.)

### Gate / environment
- `npm ci` again WORKS (exit 0), Node v22.22.2. Full gate on the fix tree (`5f2e0fd`): setup 0 ·
  typecheck 0 · lint 0 (13 pre-existing warnings, 0 errors, none on the touched file) · build 0
  (verifier: **243** client files clean) · vitest **558 files / 4028 passed / 12 skipped / 0 failed**.
- **CI-status read via GitHub MCP `pull_request_read get_status` returns 403 "Resource not accessible by
  integration"** in this env — cannot poll combined status. Rely on the `<github-webhook-activity>`
  events for CI failures instead (they wake the session); a green run is confirmed by the local gate.
- Vercel bot posts a routine "Building"→"Ready" preview-deploy comment on every nightly PR — NOT a
  review comment, no action.

## 2026-07-04

### Triage — HUGE 24h window (~80 commits, PRs #275–#300); a companion nightly PR had BOGUS triage
Window = everything merged 2026-07-03 (auth redesign #275/#276/#277/#279/#289/#291/#296/#297/#298;
buyer accounts #1b; Step-10 refunds/relink/RLS/owned-asset CDN #281–#287; tenant storefront #278;
AI store generator + product flow #292/#293/#294/#295/#300). Fanned out **5 read-only bug-hunters**
by cluster: buyer-accounts · refunds/relink/promote/assets · dashboard auth/OAuth/session/CSP ·
store-generator/AI-product-flow · RLS/tenant-read-lane/migrations. 4 → NONE (verified clean, hardened);
1 real bug found + fixed. Shipped **PR #301** (draft), branch `fix/nightly-2026-07-04`.

- **CAUTION — a companion nightly PR #299 (author Mezoh, branch `nightly-review/2026-07-04`) existed at
  run start but its triage was WRONG:** its body claims "zero commits in the last 24h, latest is
  9f49b77 4 days ago" and it therefore reviewed only OLDER cron/webhook/rate-limit modules — it never
  looked at tonight's ~80-commit landed surface. So unlike 2026-07-03 (where companion #273 genuinely
  covered the window), this run I could NOT lean on #299 for coverage; I reviewed the whole window
  myself. **Lesson:** don't trust a companion PR's "zero commits" claim — re-derive the window from
  `git log origin/main --since` yourself. (Also: the local checkout started on a STALE `main` ref /
  detached HEAD; always `git fetch origin main` and branch off `origin/main`, not the local ref.)
- Reviewed #299's 7 fixes separately (cron.detect/ingest/ingest-ads/gdpr/ingest-quickbooks error-swallow
  → 500; rate-limit XFF leftmost→rightmost/x-real-ip; remediation-guard null-cap→5). All 7 correct, no
  new defects, changed test asserts the right contract. Posted NONE (no comment).

### Bug fixed tonight — account pre-hijacking via unverified federated (Google) merge
- **`app/routes/dashboard.auth.google_.callback.tsx` Path 2** (the un-nested callback newly created by
  #298 / `1f84622`, in-window). After Google verifies the email, Path 2 linked the Google `sub` to ANY
  pre-existing local account matched **only by email string** and created a session — with NO check the
  local account had proven email ownership. Exploit: attacker `/dashboard/signup` with victim's email +
  attacker password creates an UNVERIFIED `users` row + attacker-owned tenant (`createUser` does not set
  `email_verified`); victim later "Continue with Google" → Path 2 finds the attacker row by email, binds
  the victim's Google identity, signs the victim INTO THE ATTACKER'S TENANT with the attacker's password
  surviving → account/tenant takeover. Fix: `findUserByEmail` now also returns `emailVerified`; Path 2
  refuses the silent link+session when the match is unverified (no `setGoogleSub`, no session; redirect
  `/dashboard/signin?error=verify_email_first`, GOAUTH cleared). Paths 1 & 3 untouched; legit
  verified-password→Google link still works. Added `messages.ts` copy + a test asserting the unverified
  match is refused.
- **Lesson (federated-merge pre-hijack):** any OAuth/SSO callback that auto-links a verified federated
  identity into a pre-existing local account BY EMAIL must gate on the local account being email-verified
  (or require a password proof). If password signup creates a matchable row BEFORE email verification
  (as here — `createUser` omits `email_verified`), the by-email merge is a pre-hijacking vector. Check
  every provider callback that calls a `findUserByEmail`→`setSub`→`createSession` sequence.

### Second fix — landed-in-window lint error breaking `npm run lint` for the whole repo
- **`app/routes/__tests__/dashboard.store.preview.test.tsx`** (landed via #300 / `da74383`): the
  module-under-test `import { loader }` sat BELOW the `vi.mock` calls → `import/first` ESLint error →
  `npm run lint` exit 1 repo-wide (a gate + CI step). Fix: hoist the import to the top block —
  behavior-preserving because Vitest hoists `vi.mock` above imports and the factories reference only
  `vi.hoisted` vars (test still 4/4). **Lesson:** `npm run lint` returns exit 0 despite 13 pre-existing
  WARNINGS (it's not `--max-warnings=0` globally), so a non-zero lint means a real ERROR was newly
  landed — grep the diff for it; the `import { X } from "../route"` after `vi.mock` pattern is the usual
  culprit and is always safe to hoist.

### Open-PR review
- **#299** (companion nightly): 7 fixes all verified correct → NONE (no comment). See caution above re
  its bogus triage window.
- **#267** (RR7 migration, still a DRAFT, unchanged since 2026-07-03 05:21): NOT re-reviewed — memory's
  2026-07-03 entry already reviewed it in full and posted the one real finding (the `app.settings` CSV
  5MB cap now running AFTER `request.formData()` buffers the whole body). Re-posting would be duplicate
  noise. If it changes, re-review.

### Gate / environment
- `npm ci` again WORKS here (exit 0), Node v22.22.2. Full gate on the final fix tree: setup 0 ·
  typecheck 0 · lint 0 (13 pre-existing warnings, 0 errors) · build 0 (verifier: **244** client files
  clean) · vitest **550 files / 3938 passed / 12 skipped / 0 failed**. Flaky
  `linkedin-connection.test.ts` passed this run.
- Build emits a pre-existing esbuild CSS `[WARNING] Expected "(" but found "print"` — cosmetic, not a
  failure, ignore.

### False positives cleared this run (do NOT re-flag)
- **Buyer accounts #1b** (session/magic-link/identity/account/payment-methods + storefront.account.* +
  checkout prefill): every read/write threads shop_id + session-derived buyer_id; `__Host-` cookie
  HttpOnly/Secure/SameSite=Lax; 256-bit CSPRNG tokens, single-use magic link via atomic
  `consumed_at IS NULL`, expiry enforced; saved cards store only Stripe display fields (brand/last4/exp),
  never PAN/CVV, `si.customer` ownership-checked; GDPR delete shop+buyer scoped, Stripe best-effort
  logged, DB throws; composite FK `(shop_id,buyer_id)→buyer_dim`. Clean.
- **Step-10 refunds/relink/promote/assets:** refund over-refund blocked by signed-ledger sum + FOR-UPDATE
  `record_refund_ledger` + Stripe backstop; double-refund triple-guarded (action dedup + Stripe
  idempotency key + `unique(stripe_event_id,kind)`); refund correctly NON-undoable (undoAction boundary +
  `v_audit_view` exclusion); relink buyer lookup shop-scoped + composite FK blocks cross-tenant link;
  promote inserts `on conflict do nothing` + shop-filtered + `distinct on` media (idempotent); asset
  upload session+same-origin+rate-limited, key `${shopId}/${randomUUID()}.${ext}` (no traversal),
  magic-number sniffed, size double-capped. Clean.
- **Store generator / AI product flow:** no `.server` leak into client bundles (Anthropic key confined to
  `anthropic.server`); all publish/write paths thread `session.shopId` from `requireDashboardSession`,
  cross-tenant guarded (`ownedCollectionIds`, matched-row checks); listing-draft boundary JSON-guarded +
  clamped + tool-schema-forced + `sanitizePlan`; screen-cache (b2516a1) is a per-browser module-level Map
  written only from client effects, account switch does full navigation → no cross-tenant seed;
  AI-unavailable render is defensive (optional-chaining + fallbackDoc), no null-deref. Clean.
- **RLS / tenant read lane / Step-10 migrations:** `getTenantSupabase` mints an HS256 `app_web`
  (NOBYPASSRLS) JWT bearer — NOT the service-role key; fail-closed (no GUC → zero rows). Migration
  "duplicate-looking pairs" resolved by `d080286` (only one copy of each object exists). `160000`
  app_web→SELECT-only + `170000` security_invoker guard self-test on apply; `v_audit_view.trigger_reason`
  exists since a 2026-06-15 migration (no ordering bug). `verify-rls-enforcement.mjs` uses genuine
  `SET ROLE app_web`, not the bypass key. Clean. (Sub-threshold, NOT bugs: verify script's per-table
  positive control only covers `product_dim`; `app_web` role is an environmental precondition never
  `CREATE ROLE`'d in-repo so a fully-fresh `db reset` of this repo alone would fail — both pre-date
  Step 10.)

## 2026-07-03

### Triage — big 24h window, companion nightly PR already existed
Window = everything merged 2026-07-02 (PRs #257, #260–#266, #268–#272; ~55 commits /
212 files: Stripe Connect payouts, full dashboard redesign, calibration
organic-learning, storefront checkout/analytics, security hardening). **A companion
nightly PR #273 (author Mezoh, branch `nightly-review/2026-07-03`) already existed at
run start** and fixed 5 landed bugs (media delete ordering; cron.calibration-recompute
500-escalation; ACP unsupported-currency guard; ACP pre-charge session-wedge /
`releaseAcpSessionClaim`; `cart_add` product-vs-variant id) + listed 4 deferred. Did
NOT duplicate it — hunted for what it MISSED. Fanned out 4 read-only bug-hunters
(payments/billing #269 · calibration #261–266 · security #257 + new commerce/campaign
server code #272 · dashboard connections/IA #268/#270). 3 → NONE (verified clean); 1
real bug found + fixed.

### Bug fixed tonight — disconnect leaves OAuth credential encrypted-at-rest
- **`app/lib/calderyn.server.ts` `integrations.disconnect()`** deleted the
  `integration_credentials` row ONLY for a hardcoded `SHIP_COST_CRED_KINDS` set — but
  `meta_ads`/`google_ads`/`tiktok_ads`/`quickbooks` ALSO store their encrypted OAuth
  token in the same `integration_credentials.access_token_encrypted` column (see
  `auth.{meta,google,tiktok,quickbooks}.$.tsx` upserts). So after a Disconnect the
  `shop_integrations` row was gone (UI shows disconnected, cron stops) but a
  still-valid token stayed at rest indefinitely (Google refresh never expires; Meta
  ~60d; QBO ~100d; TikTok weeks). The inline comment claiming ad/QBO tokens live as a
  bytea on `shop_integrations` was FACTUALLY WRONG. Fix: make the credential delete
  UNCONDITIONAL on the resolved `kind` (keyed `shop_id`+`kind` → credential-less
  providers match 0 rows, harmless). Shipped **PR #274**. Helper predates the window,
  but PR #268 (`77fdc64`) newly routed dashboard disconnects into it.
- **Lesson (allowlist-vs-writers):** when reviewing a delete/cleanup gated by a
  hardcoded `kind`/type allowlist, cross-check it against EVERY writer of that table —
  an inline comment asserting where a token is stored is NOT proof; grep the actual
  upsert sites. Same shape as last night's "cross-check column names against the
  migration DDL, not the test mock" lesson.
- The unit test `integrations-connect.test.ts` had a case asserting the OLD buggy
  contract ("leaves an OAuth provider's credential untouched") — updated to assert the
  credential IS deleted. (Recurring: green tests can encode the wrong contract.)

### Open-PR review
- **PR #273** (companion nightly, 5 fixes): reviewed all 5, all correct. `releaseAcpSessionClaim`
  (fix #4) canNOT reopen after a successful charge (charge is OUTSIDE the try/catch);
  soft-error routing (fix #2) still 500s real recompute throws; no reader expected a
  variant id in `storefront_event.product_id`. Posted NONE (no comment).
- **PR #267** (DRAFT: React Router 7 migration, supersedes merged #264): `response.server.ts`
  is byte-parity with Remix `json()`; `EmbeddedAppProvider` composition OK (RR7
  `AppProvider` prop is `embedded`, does NOT wrap Polaris — no double provider). Found
  ONE real regression → posted a review comment: **`app/routes/app.settings.tsx` CSV 5MB
  cap now runs AFTER `request.formData()` buffers the whole body** (undici has no size
  limit), losing the streaming `maxPartSize` DoS protection `unstable_createMemoryUploadHandler`
  gave on main. Fix = reject on Content-Length up front / stream with a size cap.

### Gate / environment — IMPORTANT UPDATE (supersedes 2026-07-01 offline recipe)
- **`npm ci` WORKS in this remote-execution environment** (exit 0, ~37s). The proxy
  here (CA bundle `/root/.ccr/ca-bundle.crt`) lets `@prisma/engines` download its
  binary fine — the whole 2026-07-01 curl-the-engine offline recipe is NOT needed
  here. Just `npm ci`. (Node is v22.22.2 in this env.) Keep the offline recipe only as
  a fallback if the environment changes back.
- Full gate on the fix branch: setup 0 · typecheck 0 · lint 0 (13 pre-existing
  warnings, none on touched files) · build 0 (verifier: 227 client files clean) ·
  vitest 522 files / 3715 passed / 11 skipped / 0 failed.
- **Flaky test:** `app/lib/social/__tests__/linkedin-connection.test.ts` (randomized
  state-tamper assertion) failed ONCE then passed on re-run. Not a regression — re-run
  if it fails in isolation.

### CI gotcha UPDATE — "Python engine tests" is GREEN now
- The fork's **"Python engine tests" GitHub Action, previously RED on every PR**
  (the `v_audit_view` / `trigger_reason` schema-ordering bug in the 2026-06-21
  migration), is now **passing** on #274's checks — it appears to have been fixed
  upstream. Stop treating a red Python-engine job as automatically pre-existing/ignorable;
  re-check. The real gate is still **"Node gate"** (the CI job that runs typecheck/lint/build/vitest).

### False positives cleared this run (do NOT re-flag)
- Stripe Connect fee/destination/idempotency wiring (#269): fee bps+flat rounded &
  clamped to [0,amount], omitted at 0, routes only to fully-onboarded accounts,
  per-order idempotency key with a distinct `_platform` fallback key, card declines
  never trigger the destination-param fallback retry. Clean.
- Calibration batch/N+1 rewrite (#265): bulk `action_pair_priors()` semantically
  identical to the retired per-pair fn; cache `upsert` only updates rows that existed
  in step 1; single-threaded cron worker pool → no torn shared counters. Clean.
- "Asks twice" no-brainer mute (#266): both `i_handle_this` surfaces handle the 409
  `CONFIRM_REQUIRED` and re-post `confirmed=true`; the Autopilot reject surface never
  offers `i_handle_this`, so it can't wedge. Clean.
- New analytics `commerce.server.ts` / `campaign-draft.server.ts` (#272): all routes
  `requireDashboardSession`, `shop_id` threaded on every read/write, Supabase errors
  thrown not swallowed, `ilike` passed as a discrete supabase-js filter param (no
  PostgREST injection), aggregate math (net = gross − refund) correct. Clean.

## 2026-07-02

### Triage result — LANDED code clean, zero fixes needed
24h window `0c4ba8b` back through the day's merges (PRs #241, #245–#250, #252–#255).
Read every substantive diff. **No high-confidence correctness bug found; no fix
branch/PR opened.** All of tonight's landed work is fresh but visibly
adversarially-reviewed (explicit edge-case handling, fail-closed logic,
idempotency). Reviewed and cleared:
- **`storefront/money.ts` + `meta.ts`** (faeaa8e, PR #253): locale pinned to en-US
  via cached `Intl.NumberFormat` to kill SSR/hydration mismatch #425; per-currency
  cache. Correct.
- **`storefront/settings.server.ts`** (80f7ebc, PR #255): settings-less shop falls
  back to `shops.display_name` then "Your store" instead of the demo label. Correct.
- **`order/cart.server.ts`** (faeaa8e): `assertPersistableShop` blocks the
  `DEMO_SHOP_ID` sentinel from the uuid cart tables on build/add/price. Correct;
  route-level demo guards mirror it (cart/checkout/PDP loaders+actions).
- **`storefront/shop.server.ts`** (b7bd823, PR #248): real tenant resolution,
  `SLUG_RE`-validated `or()` (no PostgREST filter injection), 60s TTL hit+miss cache
  w/ FIFO eviction, uninstalled shops excluded. Correct.
- **`storefront/catalog.owned.server.ts`** (6b213f2, PR #252): availability now sums
  the ledger `available` column (matches `inventory_reserve()`), chunked+paged past
  the 1000-row cap, ledger-less variants keep the editor `inventory_on_hand`
  fallback (`ledgerSellable ?? …`). Correct — a variant with ledger rows summing to 0
  correctly reads sold-out; only *no* rows → fallback.
- **`ship-cost/runner.server.ts`** (6acfe8f, PR #246): fixes /cron/ingest 504 by
  diffing in-memory + set-based RPC batches; `fetchAllRows` now THROWS on page error
  (was silently returning partial); `asError` unwraps PostgREST `[object Object]`;
  sku_pnl now writes a zero over a stale nonzero cost (old `=== 0` skip left stale
  margins). Correct.
- **`cutover/go-live.server.ts`** (30c3d61 + f3cb0c2, PR #247/#249): value-parity
  gate runs the drift sweep only after cheap structural checks pass; Shopify
  unreachable FAILS CLOSED; native shop passes; demo shops exempted via
  `isShowcaseShop` (fails safe toward real shop). Correct.
- **`dashboard.api.agentic._index.tsx`** (e5b928b, PR #250): the loader was rewritten
  to scope the client list to the shop's own non-revoked `mcp_tokens` — this
  **supersedes** last night's `client_name` column fix AND resolves the
  "not shop-scoped" item that 2026-07-01 left as a product/privacy question. Uses
  `client_name` correctly. The global-registry note below is now moot for this route.

### Open-PR review
- **PR #235** (last night's own nightly fixes, still UNMERGED): posted one review
  comment. Found a real **liveness bug in the ACP double-charge fix**:
  `claimAcpSessionForCompletion` flips `open→completing`, then cap/place/charge run
  with **no try/catch and no rollback** — a transient failure wedges the session in
  `completing` forever (retries hit `409 in_progress`; nothing sweeps a stale
  `completing`). Suggested persisting `orderId` after place (before the idempotent
  charge) so retries resume at charge. Also flagged its `edccc80` agentic commit as
  now-redundant vs merged #250. **IMPORTANT: #235's token-reuse + ACP double-charge +
  swallowed-error fixes are STILL LIVE on main (PR never merged)** — worth a nudge to
  merge (minus edccc80). PRs #47 (presentation) and #38 (test-only) are ~1mo stale,
  low-risk → NONE, no comment.

### Gate note
- Ran **no** eval gate this run: zero code changes were made (no landed bug to fix),
  so there was nothing to typecheck/build/test. The prisma-offline install recipe
  below was therefore not exercised tonight — assume still valid.

## 2026-07-01

### Bug fixed tonight
- **`app/routes/dashboard.api.agentic._index.tsx`** selected/read DB column `name`
  from `mcp_oauth_clients`, but the real column is **`client_name`** (see
  `supabase/migrations/20260608120000_mcp_oauth_clients.sql`). Against real
  Postgres/PostgREST, selecting an undefined column → error `42703` → loader
  throws → the whole Agentic Channel dashboard screen **500s on first load**.
  Source: commit `5677bc5` (PR #227, buy-in-chat P4). Fix: read `client_name`;
  DTO output key stays `name`. Shipped in PR #234.
- **Lesson (mock-hides-bug):** the route's unit test used a Supabase mock whose
  `.select()` ignores its args and returns a fixture keyed `name` — so the test
  *passed against the buggy code* and never caught the wrong column. When
  reviewing Supabase/PostgREST queries, **cross-check selected column names
  against the migration DDL, not the test mock.** A green test does not prove the
  column exists.

### Recurring bug pattern — "write-then-blank round-trip drop"
When a feature adds newly-persisted columns, the **LIST/GET loader `.select(...)`
frequently is NOT updated**, so the new fields render blank on reopen and can be
zeroed on the next save/onBlur. Seen repeatedly:
- PR #232 (owned-shipping): `dashboard.api.catalog.locations._index.tsx` list
  loader still selected `id,name,priority,lat,lng` after ship-from address fields
  were added → address blanks on reopen. Also a **snake_case↔camelCase** gap
  (`postal_code` DB vs `postalCode` VM). Commented on #232.
- Previously fixed on the product loader in `558c869` (8 shipping fields).
**Review action:** whenever a PR adds persisted columns, grep every loader that
reads that table and confirm the new columns are in the `select` AND mapped to
the VM's camelCase shape.

### False positives — do NOT re-flag
- `dashboard.api.agentic._index` lists `mcp_oauth_clients` filtered only by
  `commerce_scope=true` with **no shop scoping**. This is NOT a cross-tenant leak:
  `mcp_oauth_clients` is a **global registry** (no `shop_id`; `commerce_scope` and
  `spend_cap_cents` are per-*client* global config). Nothing to scope by.
  (Whether every merchant should see the global client list is a product/privacy
  question, not a correctness bug — don't "fix" it by inventing a shop join.)
- **Owned catalog (Slice 1, PR #229/1452045)** and **inventory ledger
  (Slice 2, PR #230/be43b38)** were triaged clean this run — heavily hardened via
  prior adversarial rounds (shop-scoped writes w/ row-count checks, FOR-UPDATE
  atomic stock fns, idempotent commit/release, cross-tenant link intersection).
  Don't re-litigate the same write-safety/shop-scoping angles.
- Commerce/ACP guardrail + signature + charge + env-gate (PR #227/#228) reviewed
  clean: guardrail denies missing/unregistered clientId, allows registered,
  spend_cap 0 = unlimited (intentional); ACP routes 404 when `ACP_ENABLED!=="true"`.

### Gate / environment gotchas (IMPORTANT — saves ~30min next run)
- **`npm ci` fails in this sandbox.** The `@prisma/engines` postinstall downloads
  engine binaries via Node's HTTP client, which **ignores `HTTPS_PROXY`** →
  `ECONNRESET`/"aborted". Registry itself is fine (it's in the proxy noProxy list).
- **Working install recipe:**
  1. `npm ci --ignore-scripts` (populates node_modules, skips the failing prisma
     engine download).
  2. Download engines via **curl** (curl honors the proxy — the prisma CDN
     `binaries.prisma.sh` is proxy-reachable):
     `BASE=https://binaries.prisma.sh/all_commits/<ENGINE_HASH>/debian-openssl-3.0.x`
     `curl -o libquery.gz $BASE/libquery_engine.so.node.gz`
     `curl -o schema.gz  $BASE/schema-engine.gz` ; gunzip both.
     Place in `node_modules/@prisma/engines/` as
     `libquery_engine-debian-openssl-3.0.x.so.node` and
     `schema-engine-debian-openssl-3.0.x` (chmod +x).
  3. Generate offline (env vars REQUIRED — bare `prisma generate`/`npm run setup`
     still hits the network even with engines present):
     `PRISMA_QUERY_ENGINE_LIBRARY=<path> PRISMA_SCHEMA_ENGINE_BINARY=<path> \`
     `PRISMA_CLI_QUERY_ENGINE_TYPE=library npx prisma generate`
     Keep these 3 env vars exported for the whole gate (setup/typecheck/build/test).
  - prisma 6.19.3 → ENGINE_HASH = `c2990dca591cba766e3b7ef5d9e8a84796e47ab7`.
    Target `debian-openssl-3.0.x` (Ubuntu 24.04, openssl 3). Re-derive the hash
    from `@prisma/engines-version/package.json` if the prisma version changes.
- **Never mask exit codes with a pipe.** `npm ci | tail` reports `tail`'s exit
  (0) even when npm failed. Use `cmd >log 2>&1; echo EXIT=$?`.
- **TS baseline noise:** with a broken/incomplete node_modules, `tsc` emits
  `TS2688` (missing `@remix-run/node`/`vite/client` type defs) and a `baseUrl`
  `TS5101` deprecation error. Both vanish once install completes. TS resolves to
  5.9.3 via the lock; tsconfig has no `ignoreDeprecations` and it's fine once deps
  are present. So TS2688/TS5101 at baseline ⇒ suspect node_modules, not code.
- Clean-tree full gate this run: setup 0 · typecheck 0 · lint 0 (13 pre-existing
  warnings, none on touched files) · build 0 (client-bundle verifier: 206 files
  clean) · vitest 478 files / 3295 passed / 11 skipped / 0 failed.

### CI gotcha (do NOT chase on nightly PRs)
- The fork's **"Python engine tests"** GitHub Action is RED for *every* PR
  (pre-existing). It applies the SQL engine-schema migrations to a Postgres
  container and dies on **`tests/engine/schema/migrations/20260621130000_autonomous_undo_window.sql`**:
  `ERROR: column aa.trigger_reason does not exist` — `v_audit_view` references
  `action_audit.trigger_reason` before it's added (schema-ordering bug in a
  2026-06-21 migration). Not a per-PR regression; local vitest is the real gate.
  Worth a dedicated fix someday, but out of scope for nightly correctness patches.
