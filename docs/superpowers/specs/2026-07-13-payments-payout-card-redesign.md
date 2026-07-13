# Payments payout card redesign

**Date:** 2026-07-13
**Surface:** dashboard Payments screen
**Status:** approved design, pre-implementation

## Problem

The Payments screen's payout section is a generic text card. Status, explanatory
copy, platform fee, balances, and actions are stacked into one prose-heavy row,
so the section is slower to scan than the payment summary above it. After Stripe
onboarding, merchants primarily need three answers: whether payouts are active,
how much is available, and how much is still pending.

## Approved direction: graphic bank card

Replace the current card with a wide, asymmetric payout panel that prioritizes
the everyday active state.

- The left side is a dark graphic surface containing the payout status,
  available balance, and an abstract 3D bank-card illustration.
- The right side contains two compact information rows: pending balance and the
  platform fee. Stripe and refresh actions sit beneath them.
- The graphic is built with CSS and is deliberately abstract. It must not show a
  fabricated account number, bank name, payout date, or other unavailable data.
- On narrow screens, the right side stacks beneath the visual surface.

The result should be more visual and materially shorter than the existing
section while remaining consistent with the dashboard's neutral palette,
typography, spacing, and light/dark theme tokens.

## Component behavior

### Active

- Show `Payouts` and the existing active status prominently.
- Make the available balance the dominant number. If Stripe returns no
  available-balance entry, show an em dash (`—`) rather than treating missing
  data as a zero balance.
- Show pending balance and `vm.feeLabel` as compact rows.
- Keep `Open Stripe` as the primary operational action and `Refresh` as a small
  secondary icon/text action.
- Preserve the current single-use Stripe login-link behavior and in-tab
  navigation.

### Not connected or onboarding incomplete

Reuse the same panel silhouette so the section does not jump to an unrelated
layout. Dim the decorative card, replace balance emphasis with one short setup
message, and show one primary action:

- `Set up payouts` when no account is connected.
- `Resume onboarding` when Stripe setup is incomplete.

The platform fee remains available as a quiet supporting detail.

### Loading and error

- Loading uses a compact skeleton shaped like the final panel instead of a
  floating text message.
- A failed billing read stays inside the same panel and exposes the existing
  `Retry` action.
- Existing toast-based errors for onboarding, Stripe login links, and refresh
  remain unchanged.

## Architecture and data flow

Keep the current ownership boundary:

1. `Payments.tsx` renders `PayoutsCard` between the summary stats and recent
   transactions.
2. `PayoutsCard.tsx` loads billing data, derives display state through
   `payoutsCardState`, and owns onboarding, Stripe dashboard, refresh, and retry
   actions.
3. The redesign changes markup and presentation only. Existing dashboard API
   calls, Stripe redirects, view-model state rules, and backend behavior remain
   intact.

Use isolated `cd-payout-*` classes in `app/styles/dashboard.css`. Do not add a
new dependency or replace shared dashboard primitives. The stylesheet already
contains unrelated working-tree edits, so implementation must append a focused
class block and avoid rewriting adjacent rules.

## Accessibility and responsive behavior

- Preserve semantic section and button elements.
- Keep visible keyboard focus for both actions.
- Give the decorative bank-card graphic `aria-hidden="true"` because it conveys
  no information beyond the adjacent text.
- Keep text contrast readable on the dark visual surface in both dashboard
  themes.
- At the mobile breakpoint, stack the panel into one column and keep both
  actions comfortably tappable without horizontal scrolling.
- Suppress decorative transitions when the user prefers reduced motion.

## Verification

- Existing `payouts-card` view-model tests continue to pass for not connected,
  onboarding, active, and fee-label states.
- Type checking confirms the component still consumes the existing billing DTO.
- Targeted component coverage verifies that active, onboarding, loading, and
  error states expose the correct labels and actions where the current test
  setup supports rendering the component.
- Visually inspect desktop and mobile widths in both light and dark themes.
- Exercise retry, refresh, onboarding, and Stripe dashboard buttons to confirm
  no interaction regressed.

## Out of scope

- Changes to payout schedules, Stripe Connect configuration, billing APIs, or
  payment summary calculations.
- Historical payout charts or trends; the current endpoint does not provide
  that data.
- Displaying bank-account identity, last four digits, or estimated payout dates.
- Redesigning the four payment summary cards or the recent-transactions table.
