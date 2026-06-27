# Live Engine Overview — Design Spec

**Date:** 2026-06-26
**Branch/worktree:** `worktree-feat+live-engine-overview`
**Design source:** claude.ai Design project `3fae1b7a-423f-4bb9-8441-9239db64d3bc`
— files `Calderyn Webapp.dc.html`, `design_handoff_live_engine/` (README + `AutopilotHero.dc.html` + `css/*`), and the per-component `live-engine-kit/`.
**Motion lib:** GSAP (core + CustomEase) via the installed `gsap-skills` (`gsap-react`, `gsap-core`, `gsap-timeline`, `gsap-plugins`, `gsap-utils`, `gsap-performance`).

---

## 1. Plain-English summary

The **Overview page becomes the "Live Engine"** — a living surface that shows the Calderyn engine *watching* the store, *flagging* problems, and *doing the work the merchant approves*, with the engine's reasoning made visible. Everything currently on the Overview (stats, charts, alert lists) moves to the **Analytics** page. We ship this on **both** surfaces: the webapp (dashboard) gets the pixel-perfect, GSAP-animated treatment; the embedded Shopify-admin home gets the same concept in a Polaris-friendly, lighter-motion form.

The signature interaction is the **approve handoff**: approving a flagged item folds the row, flies a chip up into the matching "Watching" category in the hero, runs Queued → Running → Done there, then flies into the "Acting" card and executes — all driven by **real engine data and real endpoint responses**, not the prototype's looped fake timeline.

---

## 2. Goals & non-goals

### Goals
- Replace the webapp Overview with the Live Engine experience, pixel-perfect to the design handoff (tokens, spacing, type, easing, timing).
- Wire every element to the **real** backend: `LiveEnginePageData` (features, pipeline, trace, predictions, calibration, money-protected) + the action-queue proposals + the approve / reject / toggle endpoints.
- Make the engine's reasoning legible: the Inspector panel shows *what it saw*, *how it weighed it* (factor bars + confidence vs threshold), and *what it decided*.
- Move all current Overview content into Analytics (dedupe overlap).
- Re-theme the whole dashboard from the blue accent (`#24556E`) to the design's near-black / near-white accent.
- Mirror the experience onto the embedded home (Polaris, lighter motion), moving the embedded home's current content to a new `/app/analytics`.

### Non-goals
- No new engine/detector logic, no new graduation math — the data contract already exists.
- **No environment, deploy, Remix-version, or `package.json` override changes** beyond adding the two GSAP deps. (The prior revert was an unrelated prod env-var incident; we keep this change UI+wiring only.)
- No schema migration unless a missing field is discovered during wiring (see §6.5); if so, it goes through `prisma migrate` / a Supabase migration and is called out explicitly.
- The other dashboard screens (Alerts, Campaigns, Predictor, Inventory, History, Settings) are only touched by the global re-theme sweep, not restructured.

---

## 3. Information architecture changes

### Webapp (dashboard SPA — `app/components/dashboard/`)
| Before | After |
|---|---|
| **Overview** (`screens/Dashboard.tsx`): StatRow, FocusCard, ActivityFeed, RevenueCard, AttentionSection, PredictorCard, GuardrailCard, PeerBenchmarks, + CalibrationHeader, react-grid-layout | **Overview = Live Engine**: `AutopilotHero` (full width) + two-column row (left **Calderyn Log**, right rail **Autopilot features** ⇄ **Inspector**). No grid customization. |
| **Analytics** (`screens/Analytics.tsx`): range selector, 4-KPI grid, revenue-vs-spend chart, campaign grades, top ads | **Analytics = Analytics + everything moved from Overview** (StatRow, FocusCard, ActivityFeed, RevenueCard, AttentionSection, PredictorCard, GuardrailCard, PeerBenchmarks). Dedupe the revenue chart (Analytics already has one — keep Analytics's, drop the duplicate) and the KPI overlap. |

Nav order unchanged. The standalone `CalibrationHeader` is removed from Overview (the hero owns the calibration ring); it can stay on the Action Queue screen where it already lives.

### Embedded (Polaris — `app/routes/app.*`)
| Before | After |
|---|---|
| **`/app/_index`** (home): hero focus card, stat tiles, queue list, recent actions, benchmarks (mobile + desktop branches) | **`/app/_index` = Live Engine** (Polaris `LiveEngineHero` + `CalderynLog`), lighter motion. |
| (no analytics route) | **new `/app/analytics`**: the home's prior content (focus, stats, queue snapshot, recent actions, benchmarks). |
| **`/app/engine`** (existing Live Engine page) | Its job is now the home → `/app/engine` **redirects to `/app/_index`**. (Keep the route file as a thin redirect to avoid breaking deep links.) |
| **`/app/queue`** (Action Queue v2) | Unchanged — remains the full queue. The home Calderyn Log links to it ("See all"). |

---

## 4. Real-data wiring (the "fully wired" contract)

Single source of truth already exists: `buildLiveEnginePageData(client, signal)` → `LiveEnginePageData` (`app/lib/calibration/live-engine-types.ts`):
```
{ autopilotEnabled, moneyProtectedWeekCents, features[], pipeline[], trace[],
  predictions[], calibrationPct, nearGraduation }
```
Already fetched on the dashboard via `fetchLiveEngine()` and polled every 45s; on embedded via `app.engine.tsx`'s loader.

| UI element | Real data source |
|---|---|
| Hero hex meter (N of 6 edges) + "N features active" | `features[]` where `enabled` — active count |
| Title crossfade "watching ⇄ running" | derived **engine status**: `running` while an action is executing (handoff in flight or an autopilot run reported), else `watching` |
| Calibration ring + "Level X of 5" | `calibrationPct` → band/level via existing `calibrationBand()` helper |
| "$ protected this week" | `moneyProtectedWeekCents` |
| Watching groups (Inventory / Ads / Pricing / Retention) — active/idle/disabled + flagged | feature categories (which domains have active features) + **flagged** = a pending proposal exists in that domain. Domain comes from the detector→domain map (`labels.ts`), **not** text inference. |
| Acting card (name, why, steps, money, badge) | the currently-executing action (the approved proposal during a handoff; otherwise `STANDING BY`) |
| Calderyn Log feed | **pending** = action-queue proposals (`client.queue.list()` → `QueueProposal[]`, rendered as `NEEDS YOU` + Approve/Deny). **history** = `trace[]` (`TraceEventVM` → APPROVED / RUNNING / DONE / DISMISSED). Merged, newest first, internally scrollable. |
| Inspector (WHAT IT SAW / HOW IT WEIGHED / DECISION) | for a **trace** row: `TraceEventVM.signal`, `evidence[]`, `factors[]`, `confidence`, `threshold`, `decisionLabel`, `decisionNote`. For a **pending** row: the proposal's `confidence` + the matching `pipeline[]` `factors` + the alert's `evidence` (see §6.5). |

### Approve / Deny / Toggle (real endpoints)
- **Approve** (webapp): call the real approve path (dashboard equivalent of embedded `POST /app/alerts/$id` → `executeAction()` + `recordApproval()` → receipt `{ delta, before, after, justGraduated, graduatable }`). On success: dispatch `le-dock { group, label, money, moneyShort }` to the hero → dock → Acting → execute. Bump the calibration ring by the **real** `delta` (not a hard-coded +6). Then revalidate live-engine + queue.
- **Deny** (webapp): inline reason chips → real reject path (`recordRejection()` → `{ reflection, delta, savedAsRule, ruleKind }`). Mark row `DISMISSED`; nudge ring by the real (small) delta; show the learned-rule reflection.
- **Toggle** a feature → existing `/dashboard/api/live-engine/toggle` (embedded: `POST /app/engine`). Updates the "N on" badge and the hero hex meter.
- Embedded uses its existing approve (`/app/alerts/$id`), reject (`/app/queue`), toggle (`/app/engine`) endpoints — same contract.

### The integration seam (keep it)
The README's `window` CustomEvent seam is the clean boundary between the **page** (Calderyn Log = data/state) and the **hero** (GSAP = motion). We keep it, but the events now carry **real** data fired on **real** endpoint success:
- `le-openreason` — ensure reasoning panel open (target group row exists) before docking.
- `le-dock { group, label, money, moneyShort }` — approved item docks → Queued/Running/Done → flies to Acting → executes. **This is the approve path.**
- `le-calibrate { kind: "approve" | "deny", delta }` — bump the ring by the real delta.
- `le-did { icon, title, steps, money, moneyShort }` — an action completed; append to the log (and reconcile with the next poll).

Typed wrapper lives in `app/components/dashboard/engine-events.ts` (restored/adapted from `794978c`).

---

## 5. Re-theme (global, brand accent only)

Port the design's `css/dashboard.css` tokens into `app/styles/dashboard.css`:
- Light: `--accent:#1A1A1C; --on-accent:#FFFFFF; --bg:#F5F5F7; --card-solid:#FFFFFF; --text-1:#1D1D1F; --text-2:#6E6E73; --text-3:#AEAEB2; --hairline:rgba(0,0,0,.045); --hairline-strong:rgba(0,0,0,.12); --radius:16px;` plus `--shadow-card` per README.
- Dark (`.cd-dark`): `--accent:#F2F2F4; --on-accent:#16161A; --bg:#1C1C1E; --card-solid:#2C2C2E; --text-1:#F5F5F7; --text-2:#98989F; --text-3:#636366; --hairline:rgba(255,255,255,.07); --hairline-strong:rgba(255,255,255,.18);`
- Semantic colors stay: `--red:#E0352B; --green:#248A3D; --orange:#C93B00; --yellow-fg:#946300`. Only the **brand accent** flips black/white — winning/poor/severity colors keep their meaning.
- On the Overview `.cd-root`, set `--radius:14px; --glass:.72; --density:1; --type-scale:1.1`.
- Sweep all dashboard screens/components for **hardcoded** blue (`#24556E`, old `--accent` color-mix usages) and replace with `var(--accent)`. Verify each screen still reads correctly in light + dark.

---

## 6. Components & files

### 6.1 Webapp hero (restore from `794978c`, re-derive visuals from current design)
- `app/components/dashboard/hero/AutopilotHero.tsx` — header (hex/feature-meter, title crossfade, calibration ring, $ protected), three-column engine body (Watching / scanning / Acting), expandable reasoning panel.
- `app/components/dashboard/hero/hero-motion.ts` — GSAP `HeroEngine`: hex meter draw, calibration ring tween + optimistic bump, watching-row scan sweep, the **dock sequence** (`runDockSequence`), **chip bezier flight** (`chipFlyToAct`), Acting **receive + execute** (`receiveHandoff`, `actExecute`). Built with `useGSAP` + `gsap.context()` cleanup + `CustomEase`; `gsap.matchMedia()` for `prefers-reduced-motion`.

### 6.2 Webapp overview body
- `app/components/dashboard/overview/CalderynLog.tsx` — merged feed; pending rows with Approve/Deny; `approveReview` / `foldAndDock` / `groupForReview`; wired to real approve/reject endpoints.
- `app/components/dashboard/overview/AutopilotFeatures.tsx` — collapsible groups (Ads & campaigns / Inventory / Pricing / Retention), per-feature toggle, **locked** features (lock icon, `title="Approve more to unlock"`), "N on" badge, internal scroll (`max-height:360px`), built to scale to ~15 features.
- `app/components/dashboard/overview/InspectorPanel.tsx` — back chevron + tag + timestamp; WHAT IT SAW (signal + evidence chips), HOW IT WEIGHED THIS (factor bars + confidence% + note), DECISION (pill + note). Replaces the features card when a flagged/trace item is opened.
- `app/components/dashboard/overview/features-model.ts` — builds the grouped feature view-model from `LiveEnginePageData.features` + pending proposals (merges graduated/enabled + locked-pending).
- `app/components/dashboard/engine-events.ts` — typed CustomEvent helpers.

### 6.3 Webapp screens
- `app/components/dashboard/screens/Dashboard.tsx` — becomes the Live Engine Overview (hero + log + rail). Remove grid-layout machinery and the moved cards.
- `app/components/dashboard/screens/Analytics.tsx` — absorb the moved Overview cards; dedupe revenue chart + KPI overlap.
- `app/lib/dashboard/client.ts` — ensure `fetchActionQueue()` (pending) + `fetchLiveEngine()` (trace/features/etc.) feed the log; add the approve/deny client calls if not already present.

### 6.4 Embedded (Polaris)
- `app/components/calderyn/LiveEngineHero.tsx` — Polaris-composed hero (hex/feature-meter, watching/acting, calibration ring, $ protected). Lighter motion: GSAP allowed but minimal (count-ups, ring, simple chip move) or CSS; **degrade gracefully in the iframe**.
- `app/components/calderyn/CalderynLog.tsx` — Polaris log (trace + pending) with Approve/Deny via existing endpoints.
- `app/routes/app._index.tsx` → Live Engine home; `app/routes/app.analytics.tsx` → new, holds moved content; `app/routes/app.engine.tsx` → redirect to home.

### 6.5 Inspector data for pending items (possible small enrichment)
Pending proposals (`QueueProposal`) carry `confidence` + `reasoning` but not the full factor breakdown / evidence chips. `pipeline[]` (`PipelineCallVM`) has `factors` + `threshold`; alerts carry `evidence` (`alert_context`). Wiring task: when opening the Inspector on a **pending** row, join proposal → pipeline (by detector+action) → alert evidence to populate WHAT IT SAW / HOW IT WEIGHED. If `buildLiveEnginePageData` doesn't already expose per-proposal factors+evidence, add a thin enrichment to the loader (no schema change). Confirm during implementation before assuming a migration is needed.

### 6.6 Dependencies
Add `gsap` and `@gsap/react` to `package.json` (the only new deps; flagged per CLAUDE.md — small, MIT-compatible "no-charge" GSAP license, already vetted Low Risk by the skills install). Nothing else added or overridden. Do **not** touch `@remix-run/*` / `@vercel/remix` pins.

---

## 7. The Approve Handoff — motion spec (intended production timings)

1. **Flash + label** (in log): row → `APPROVED`, icon → check, money line muted "Sending to <Group> autopilot", calibration bumps (~0.2s collapse of actions).
2. **Fold + lift** (delay 0.7s): row collapses (`height/opacity/padding → 0`, 0.55s `power2.inOut`), rows below slide up; a **chip** (accent square + hex mark + label, `radius:12px`, `1.5px solid accent`, soft shadow) appears over the row.
3. **Wrap + fly to group**: chip shrinks (~330→~168px, 0.65s) and travels a **lifted quadratic bezier arc** (control point ~84px above the start/end midpoint) to its Watching group row, then fades (~1.2s `power2.inOut`). Destination by **domain** (inventory/restock→Inventory, price/margin→Pricing, campaign/spend→Ads, cart/retention→Retention).
4. **Dock + run in group**: group row gets accent border + `back.out` scale pop; status **Queued** (~1.45s) → **Running** (2px accent progress bar sweeps L→R ~1.9s) → **Done** (check pops); settles to idle after ~1.4s, restoring the normal icon.
5. **Fly to Acting** (same chip arc as step 3): chip flies from group row into the Acting card. Card "arms for intake": badge `RECEIVING`; a **fixed-position outline overlay traces the card's real bounding rect (+~2px)** — NOT an `inset:-2px` child (rounded clipping bug, already fixed). On arrival: ripple ring expands, card squash + `elastic.out(1,0.55)` settle, light sweep.
6. **Execute**: badge `RUNNING`, step checklist runs (spinner→check, progress fill, ~11.5s nominal × speed), then `DONE` + money result, returns to `STANDING BY` after ~2.8s; engine resumes watching.

**Eases:** `power2.inOut` (flights/collapses), `back.out(2.2–2.6)` (pops), `elastic.out(1,0.55)` (card settle), `sine.out` (glows).

---

## 8. Non-negotiable fidelity rules (from the handoff)
- **Steps 3 and 5 use the same** chip-arc animation (explicit requirement).
- Intake outline traces the **real card border** via bounding rect, not an inner-edge child.
- **Never** use sonar / pulse / radar / scanner-circle motifs (explicitly rejected as "vibecoded"). Use scans, sweeps, draws, arcs.
- Use the **system font stack**; no condensed "eyebrow" font for SCANNING/CLEAR labels.
- Title crossfade is a **fade**, not a slide.
- Reasoning toggle: chevron eases beside the label then flips; **guard re-entrancy** (rapid toggling previously left it half-open).
- `prefers-reduced-motion`: everything degrades to instant state changes (`gsap.matchMedia`).
- Pacing is the already-slowed "readable, not frantic" pass — keep these values.

---

## 9. Risk & safety
- **UI + wiring only.** No env vars, no deploy config, no Remix/Vercel version changes — the prior revert was a Vercel "sensitive" env-var prod incident bundled with the hero, not a UI fault. Keep this change isolated to the worktree/branch and the file list above.
- **Browser-visible source hygiene:** no AI/prototype provenance comments, no `support.js`, no dev overlays/HMR/wildcard postMessage; `npm run build` must keep `scripts/verify-client-bundle.mjs` green; client sourcemaps stay disabled.
- **Server/client split:** hero motion + log are client modules; never import `*.server` from them. Loaders stay read-only; mutations via actions; redirect after success.
- **Embedded:** App Bridge for nav/toasts; `@shopify/polaris-icons` (not Lucide) on `app/routes/app.*`; the dashboard side uses `CDIcon`/lucide as today.
- **Parity:** both surfaces ship in this task (mandatory). If only one can land, say so and leave a TODO — but the plan is both.

---

## 10. Verification (pre-commit gate)
1. `/code-review` on the working tree — resolve blockers.
2. Patch sanity: `git diff --check`, no stray `console.log`/`.only`/provenance/design-tool markers.
3. `npm run typecheck` → 0; `npm run lint` (`--max-warnings=0` on touched files) → 0; `npm run build` (incl. client-bundle verifier) → 0.
4. `npx prisma validate` / `migrate diff --exit-code` only if a migration was actually added (§6.5).
5. Run the app (`/run`) and exercise the approve handoff end-to-end against seed data on the showcase store; confirm light + dark, reduced-motion, and that approve/deny/toggle hit real endpoints and the ring moves by the real delta.

---

## 11. Open questions / assumptions
- **A1 (confirmed):** Re-theme is global black/white; only the brand accent flips.
- **A2 (confirmed):** Overview = Live Engine only; all current Overview cards move to Analytics.
- **A3 (confirmed):** GSAP via the linked gsap-skills.
- **A4 (assumed — confirm):** Embedded mirror is faithful — home becomes Live-Engine-only and its current content moves to a new `/app/analytics` (vs. "hero on top, keep the rest"). Proceeding with the faithful mirror unless told otherwise.
- **A5 (to verify in code):** whether the live-engine loader already exposes per-proposal factors+evidence for the pending-item Inspector, or needs a thin loader enrichment (§6.5). No schema change expected.
