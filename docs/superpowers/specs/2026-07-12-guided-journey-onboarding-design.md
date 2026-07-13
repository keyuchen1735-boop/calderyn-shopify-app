# Guided Journey Onboarding — Design

**Date:** 2026-07-12
**Status:** Approved by John (conversation), pending spec review
**Surfaces:** Native dashboard only (`app/routes/dashboard.*`, `app/components/dashboard/`). No changes to the legacy embedded app.

## Problem

Watched signups (3 users) all stalled the same way: they added a first product, then wandered the sidebar and left. Three concrete paper cuts made it worse:

1. The Autopilot gauge on Home animated to a stale percentage (e.g. 47%) then dropped to 0% once boot finished and the store was detected as fresh.
2. "Continue with Shopify" on the login page 302s new users straight into Shopify OAuth (`/dashboard/login`), a dead end for someone without a connected shop.
3. The add-product flow (`NewProductFlow.tsx`) showed too many variant rows and too much text at once; the shipping and organize sections confused users.

The deeper issue: the current setup guide (3 tracked milestones on main) is a static list. It does not react when a step completes, does not point at the next action, and ends without a payoff. Nothing pulls the user forward.

## Goals

- There is always exactly one spotlighted next action for a new user, from signup through first real order.
- Completing a step is *felt* (visible check-off + toast) wherever in the app it happens.
- The journey ends with a restrained, premium payoff — no confetti.
- Ship the three paper-cut fixes first, independently of the journey work.

## Non-goals

- Custom domains, teammate invites, ad campaigns, or branding steps as milestones.
- Any tour/coach-mark system.
- Changes to `app/routes/app.*` (legacy embedded surface).

---

## Part B — paper-cut fixes (ship first, separate small PRs off main)

### B1. Calibrator race
`TickGauge` on Home must not sweep until `dormant` is determinable (i.e. `app.booted`). Fresh or signal-less stores render "Autopilot · standing by" at 0 from first paint; established stores sweep once to the real pct. No intermediate sweep to a stale `calibration_pct`.

### B2. Login "Continue with Shopify"
The login-page Shopify button currently links to `/dashboard/login` (immediate Shopify OAuth). Change: route it into the signup + import intent — new users land in account creation with the Shopify import step pre-selected; existing users with a connected shop keep working as today. If that split proves awkward in code, fallback is removing the button from the login picker (it remains on signup/onboarding as "Import from Shopify").

### B3. NewProductFlow diet
- Variants: combo table (per-combination price/stock grid) hidden behind progressive disclosure — show it only after the user adds a second option value, and collapse it by default.
- Copy diet: cut helper text to one short line per section.
- Shipping: replace the current physical/weight/dims block with a single question — "Does this ship in a box?" Yes reveals weight + dimensions; No marks the product digital/non-physical.
- Organize (tags/vendor/collections): stays in the collapsed extras card, relabeled in plain language.

Note: `NewProductFlow.tsx` carries uncommitted WIP on `feat/autopilot-agentic-redesign`. B3 is built off main; the merge overlap must be flagged when that branch lands.

---

## Part A — the guided journey

### Milestones (3 phases × 3 steps)

| Phase | Step | Completion signal |
|---|---|---|
| 1 Foundation | Create your account | always complete at first render |
| 1 Foundation | Add your first product (or import from Shopify) | catalog count > 0 (either path checks the same box) |
| 1 Foundation | Connect payouts | Stripe account fully enabled |
| 2 Launch | Set up shipping | origin address + at least one rate configured |
| 2 Launch | Publish your storefront | storefront published flag |
| 2 Launch | Place a test order | an order flagged `is_test` exists — the step's CTA launches the merchant's own storefront checkout in Stripe test mode and tags the resulting order as test (exact flag column decided at implementation-plan time against the current orders schema) |
| 3 First wins | Turn on Autopilot | `shops.autopilot_enabled` true (standby counts) |
| 3 First wins | Ask Calderyn a question | ≥1 assistant conversation for the shop |
| 3 First wins | First real order | first non-test order lands |

Phases unlock in order. Steps within a phase can complete in any order.

### State model

New table `shop_setup_progress` (shop-scoped, RLS, SQL migration):

- `shop_id`, `milestone_key` (enum-like text), `completed_at timestamptz`, PK `(shop_id, milestone_key)`.

Milestones are **derived** from existing data by a recompute function in `app/lib/onboarding/journey.server.ts`. The table exists to (a) give stable `completed_at` timestamps for animations/toasts, and (b) make completion sticky — deleting the first product later does not un-check the step. Recompute is idempotent: it only inserts missing rows, never deletes.

Recompute triggers: called from the actions that can complete a milestone (product save, import promote, Stripe status refresh, shipping save, storefront publish, order creation, autopilot toggle, assistant message) plus lazily on the Home/setup-progress loader as a catch-all. No cron.

### API + cache

`app/routes/dashboard.api.setup-progress._index.tsx` → `{ phase, steps: [{key, label, done, completedAt}], newlyCompleted: [] }` behind `requireDashboardSession`. Seeds + writes through the session screen-cache and gets a `WARM_TARGETS` entry so Home paints instantly.

### Home card behavior

The existing setup-guide card slot becomes the journey card:

- Within a phase: completed steps show a subtle GSAP check-off; the next incomplete step's row is expanded with a one-line pitch + primary CTA. Exactly one primary CTA visible at a time.
- Phase completion: completed phase collapses to a compact "Foundation ✓" chip; next phase's three steps slide in. Same card slot, no layout jump.
- After first real order: card retires into a one-time recap ("Built in N days · X products · live at <url>") with a dismiss that removes it permanently (dismissal stored per shop).

### Toasts (completion anywhere)

A small client watcher (in `DashboardApp`) diffs `newlyCompleted` from the setup-progress payload against a session-seen set. Completing a step anywhere fires one quiet toast — "Payouts connected — next: shipping" — deep-linking to the next step's screen. One toast per completion, never queued into a pile.

### Finish line + handoffs

- Storefront publish → restrained full-width "You're live" card on Home: storefront URL, copy-link button; the Autopilot gauge does its first genuine sweep as real signals arrive. No confetti.
- Relay handoffs: first product save ends on a "here's what you made" beat with a storefront CTA; publish ends on the live-link beat with a test-order CTA; test order ends pointing at Autopilot.

### Error handling

- Setup-progress fetch failure: Home renders the card from the last cached payload; if none, renders the static step list without live state (never blocks Home).
- Recompute failures are logged and surfaced per repo rule (no swallowed Supabase errors); a failed recompute never blocks the triggering action.

### Testing

- Unit: derivation logic in `journey.server.ts` (each milestone's signal, stickiness, phase gating).
- Unit: toast watcher diffing (no repeat toasts within a session).
- Manual e2e on the demo shop: fresh-store run-through of all 9 steps; verify card morph, toasts, retire/recap.

### Rollout

1. Part B fixes: three small PRs off main (B1, B2, B3), each through the standard pre-commit gate.
2. Part A: one feature branch `feat/guided-journey` in its own worktree — migration + server lib first, then API/cache, then Home card, then toasts/finish line.
