# Autopilot explainable action cards — design

**Date:** 2026-07-06
**Surface:** Dashboard → Autopilot page (`CalibrationTrainer` rows)
**Type:** Front-end UX change. No server, schema, or data-contract changes.

## Problem

The Autopilot page's calibration queue shows each pending proposal as a single
truncated line: an icon, the alert `title` (clipped to one line), a bare
`92%`, and Reject / Approve buttons. A merchant sees *what* is being proposed
only partially and *why* not at all. There is no plain-language reason, no
dollar stake, and no orientation for what the list is or what approving does.
Result: the queue is illegible to a first-time user, so they don't engage with
Autopilot at all.

The data needed to fix this already exists on every proposal — it's just
discarded by the current row.

## What already exists (no new data)

Every `QueueProposalVM` (`app/components/dashboard/view-models.ts`) carries:

- `title` — the alert's subject (product / campaign name), e.g. `"Summer Sale — Meta"`
- `action_kind` — the proposed action
- `detector_id` — the problem category
- `reasoning` — the alert narrative (a one-line plain-language "why"); built
  server-side as `reasoning: a.narrative` in `app/lib/calibration/queue.server.ts`
- `dollar_impact` — money at stake
- `confidence` — calibrated 0–100
- `always_ask` / `over_autopilot_cap` — optional flags

Plain-language label helpers already live in `app/lib/labels.ts`:

- `featureLabel(detector_id, action_kind)` — disambiguated action headline
  ("Pause money-losing campaigns", "Raise price to restore margin")
- `ACTION_LABELS[action_kind]` — plain action label (fallback)
- `detectorLabel(detector_id)` — plain problem category ("Campaign is losing money")

## Design

Replace each `cd-sug-row` in `CalibrationTrainer` with an explainable card.
Everything below is presentation only — the approve/reject handlers, the
`teachingBusy` single-signal lock, toasts, and `app.refresh()` are unchanged.

### Card anatomy

```
┌────────────────────────────────────────────────────┐
│ ⚡ Pause money-losing campaigns          92% sure   │
│    Summer Sale — Meta                               │
│                                                      │
│ Why: Campaign is losing money.                      │
│ Spend up 40% but sales flat for 3 days.             │
│                                                      │
│ Keeps ~$540/mo   [ Not now ]        [ Do it → ]     │
└────────────────────────────────────────────────────┘
```

1. **Headline** = `featureLabel(detector_id, action_kind)` (what Calderyn wants
   to do) + the action icon (`CD_ACTION_ICON[action_kind]`, existing).
2. **Subject** = `title` — one muted line naming the product/campaign.
3. **Confidence** = `{confidence}% sure` (top-right of the card).
4. **Why block**:
   - First line: `Why: {detectorLabel(detector_id)}.` — always present.
   - Second line: `reasoning` (the narrative).
   - **Fallback:** if `reasoning` is empty/blank, show only the
     `detectorLabel()` line. The card is never reason-less.
5. **Dollar framing** = `dollar_impact` rendered with `money()`, prefixed by a
   verb chosen from the sign/action so it reads as a benefit:
   - loss-stopping actions (pause / reduce / exclude / discontinue) → `Keeps ~$X`
   - growth actions (increase budget / reallocate to winner / reorder) → `Earns ~$X`
   - Omit the dollar line when `dollar_impact` is 0.
6. **Actions**:
   - Secondary **"Not now"** — toggles the existing inline reject-reason chips
     (same `rejecting` state, same `REJECT_CHIPS`, same `reject()` call).
   - Primary — **"Do it"** when `canOneClick(p)` is true, **"Review"** when not
     (unchanged `approve()` → `onReview()` branch). Shows "Doing…" while
     `approving === p.alertId` (renamed from "Approving…" for plainness).
7. **Badge:** when `over_autopilot_cap` is set, a small pill reading
   *"Above your autopilot limit"*; when `always_ask` is set, *"Always ask"*.
   These sit near the headline so flagged proposals don't read as normal ones.

### Reject panel

Unchanged in behavior; restyled to sit inside the card (below the action row)
instead of as a sibling `cd-reject-panel`. Chips (Too risky / Wrong timing /
Doesn't fit) + free-text "Other reason" + Send. Same `teachingBusy` disabling.

### Orientation line

Under the existing "Approve to train · {n} left" header, add one muted line:

> Calderyn spotted these while watching your store. Approve the good calls to
> teach it — soon it handles them for you.

This gives a first-timer the "what is this / why should I act" that the bare
list lacks.

### Empty state

Unchanged: "Nothing waiting. Calderyn is scanning."

## Files touched

- `app/components/dashboard/screens/Autopilot.tsx` — rewrite the row markup
  inside `CalibrationTrainer.queue.map(...)`; add small helpers for the dollar
  verb and the reason fallback. Import `featureLabel`, `detectorLabel` from
  `~/lib/labels`.
- `app/styles/dashboard.css` — new `.cd-actcard*` classes (card, headline,
  why-block, footer, badge). Reuse existing tokens (`--text-1`, `--text-2`,
  chip/button styles). No new design primitives.

## Out of scope

- The Live Engine graduated panel (`LiveEnginePanel`) — untouched.
- The feature switchboard (`AutopilotFeatures`) — untouched.
- The Home/Dashboard triage deck — same pattern exists there but is deferred to
  a possible second pass; not part of this change.
- Any server, view-model, or DB change.

## Testing / verification

- `npm run typecheck`, `npm run lint --max-warnings=0`, `npm run build` green
  (per repo pre-commit gate; build runs `verify-client-bundle.mjs`).
- No AI/provenance markers in the new browser-visible strings.
- Manual: on a store mid-calibration, each pending proposal renders headline +
  subject + reason (or category fallback) + dollar + correct primary label
  ("Do it" vs "Review"); Not now expands the reason chips; approve/reject still
  train and refresh.
