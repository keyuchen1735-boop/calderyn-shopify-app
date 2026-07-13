# Autopilot screen UI redesign

Date: 2026-07-12 · Status: approved by John (chat) · Surface: `app/components/dashboard/screens/Autopilot.tsx`, `app/components/dashboard/overview/AutopilotFeatures.tsx`

## Problem

The calibration state of the Autopilot screen was unpleasant and hard to scan:

- The gauge column vertically centered a 184px gauge in a column as tall as the whole queue, leaving a huge dead void.
- The "Approve to train" queue rendered one tall gray card per proposal with weak hierarchy (small title, mid-gray why-line always visible, floating "% sure"), so nine proposals read as a wall.
- The "Autopilot features" switchboard spent a full-width row (plus lock icon) on every locked catalog feature: ~15 rows of mostly-locked list.

## Design (approved)

1. **Gauge rail.** The left column narrows to 224px and top-aligns; under the gauge sit the three numbers that matter (`pts to full auto`, `waiting on you`, `$ on the table`). The rail is `position: sticky` so it rides along while a long queue scrolls (card uses `overflow: clip`, not `hidden`, to keep sticky working).

2. **Queue: grouped, compact, expandable.** Proposals cluster by move type (Stop wasted spend / Restock / Scale winners / Pricing / Other, mapped from `action_kind` in `autopilot-cards.ts`). Each group has a slim header (icon, uppercase label, count, total `~$`, and an "Approve all N" button when every item in the group is one-click executable; it runs sequentially like Home's batch card). Each item is one compact row: plain-English sentence (`sayLine()` templates, e.g. "Reorder Crestline Pack 28L before it runs out"), a green money figure, a quiet confidence %, and the Not now / Do it buttons. Clicking the row (or "Not now") expands the why-line plus the reject-reason chips beneath it; explanations are on demand instead of graying every card.

3. **Features: two-column chip grid.** Domain groups render as side-by-side cells (1-column under 840px). Unlocked features are toggle chips (whole chip is the switch, trailing mini-toggle visual; training pairs show `n/m` progress, proven-but-off pairs show "ready"). The locked catalog folds into one line per cell, "N more unlock as calibration grows", expandable into muted locked chips. Header keeps the "N on" pill and adds "X of Y unlocked".

Behavior is unchanged underneath: same approve/reject/toggle endpoints, same one-click gating, same teaching-busy lock (one signal at a time; group approve counts as busy).

## Out of scope

The graduated Live Engine panel and the standing-by/error placeholders are untouched.
