# Dashboard StatTile animations — design

**Date:** 2026-06-06
**Status:** Approved (pending implementation plan)
**Topic:** Subtle, Polaris-appropriate motion for the embedded admin dashboard.

## Purpose

Add a small set of subtle, purposeful animations to the dashboard so the UI feels
responsive and "alive" without violating Shopify's guidance that motion in the admin
be functional and restrained. Three effects, all opt-out under reduced-motion.

## Out of scope

- **"Free with Polaris" animations** (Toast, Modal, Banner, skeleton loaders, the nav
  loading bar). These animate automatically wherever the component is used and are
  already in play (e.g. action Toasts on alerts/campaigns). Nothing to build.
- **Animated meter fill (demo "D").** The GuardrailMeter already has a `width`
  transition (`.cdn-meter-fill`); no additional work wanted.
- No new dependencies. CSS + a tiny React helper only.

## The three effects

| # | Effect | Implementation | Scope |
|---|--------|----------------|-------|
| A | Hover lift | CSS only on `.cdn-tile-button` | Every clickable `StatTile`, app-wide |
| B | Count-up | New `<CountUp>` helper rendered inside `StatTile` | Every `StatTile` with a numeric `value` |
| C | Fade-in stagger | A CSS class on the dashboard stat-row container | Main dashboard 4-card row only |

### A · Hover lift (CSS only)

On `.cdn-tile-button` (the whole-tile click target in
`app/components/calderyn/calderyn.css`), add a hover state:

- `transform: translateY(-3px)` + a slightly stronger box-shadow.
- Transition uses `--cdn-ease-out` at ~200ms (already defined).
- Reduced-motion: no transform/shadow change (covered by the existing
  `@media (prefers-reduced-motion: reduce)` block — extend it to neutralize the
  transition).

Because the rule lives on the shared button class, every clickable tile gets it
automatically (dashboard, analytics, campaigns).

### B · Count-up (small React helper)

CSS cannot count, and StatTile values are mixed formats: `15`, `$0`, `0.8×`,
money with commas (`$1,234`). A new helper handles all of them.

- **New component:** `CountUp` in `app/components/calderyn/` (e.g. `CountUp.tsx`,
  exported from the calderyn index).
- **Props:** `value: string` (the already-formatted display string), optional
  `durationMs` (default ~900).
- **Behavior:** split `value` into `prefix` (leading non-digits, e.g. `$`),
  `number` (the numeric core, commas stripped for the tween then re-inserted),
  and `suffix` (trailing non-digits, e.g. `×`, `%`). Animate only the numeric core
  from 0 → target with an ease-out curve via `requestAnimationFrame`, re-assembling
  `prefix + formatted(number) + suffix` each frame.
- **Decimals:** preserve the target's decimal places (so `0.8×` animates 0.0 → 0.8,
  not 0 → 1).
- **Integration:** in `StatTile`, replace the raw `{value}` render with
  `<CountUp value={value} />` when `value` is set. The tabular-nums span
  (`.cdn-tnum`) stays so digits don't jitter width while ticking.
- **Reduced-motion:** render the final `value` immediately, no tween.
- **Re-render safety:** if `value` changes (re-fetch/navigation), animate from the
  current displayed number to the new target; clean up the rAF on unmount.

### C · Fade-in stagger (CSS only)

- Add a class (e.g. `cdn-stat-row`) to the dashboard stat row wrapper. Since the row
  is an `InlineGrid`, wrap it or apply the class such that its tile children can be
  targeted (`> *`).
- Children start `opacity: 0; translateY(10px)` and animate to visible via a keyframe,
  with incremental `animation-delay` per child (~90ms apart) on mount.
- Reduced-motion: children render fully visible with no animation/delay.
- Scope: dashboard stat row only for now (`app/routes/app._index.tsx`). Other pages'
  rows can adopt the class later if desired.

## Motion rules (apply to all three)

1. **Timing/easing** uses the existing `--cdn-ease-out` token; durations in the
   200–900ms range. No arbitrary curves.
2. **`prefers-reduced-motion: reduce`** disables all three (instant final state).
   Extend the existing media block in `calderyn.css`.

## Files touched

- `app/components/calderyn/calderyn.css` — hover-lift rule, stagger keyframe + row
  class, reduced-motion extensions.
- `app/components/calderyn/CountUp.tsx` — new helper.
- `app/components/calderyn/index.tsx` — export `CountUp`; use it in `StatTile`.
- `app/routes/app._index.tsx` — add the stagger class to the stat row.

## Testing

- **Typecheck / lint / build** green (CLAUDE.md pre-commit gate; StatTile is a
  UI component → major-commit gate applies).
- **CountUp unit test** (the only piece with real logic): given mixed inputs
  (`"15"`, `"$0"`, `"0.8×"`, `"$1,234"`), it ends on exactly the input string, and
  under a mocked reduced-motion preference it renders the final value immediately.
- **Manual:** verify on the dashboard that tiles lift on hover, numbers tick up on
  load, the row staggers in, and that enabling "reduce motion" in the OS disables
  all three.

## Risks / notes

- Count-up is the only correctness-sensitive piece (string parsing + formatting);
  it carries the unit test. A/C are presentational CSS.
- Embedded-iframe performance: all three are transform/opacity or short rAF tweens —
  cheap, no layout thrash.
