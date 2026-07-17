# Autopilot Live Action Stream

## Goal

Make the calibration screen feel active without overwhelming merchants with the full action queue.

Success means:

- Real queued actions continuously rotate through a compact stream.
- Each incoming action flies into the top; the bottom visible action exits.
- Merchants can pause the motion and review every action in a static list.
- The summary focuses only on calibration percentage and dollars at risk.
- Accepting or rejecting an action refreshes both values from real application data.
- The screen uses Calderyn's existing theme tokens, components, and action behavior.

## Production UI

The existing calibration card remains a two-column Calderyn card.

The left column contains:

- The existing percentage gauge as the dominant graphic, labelled `calibrated`.
- One secondary monetary value, labelled `dollars at risk across waiting actions`.

The right column contains:

- A `Scanning live` status and `Action stream` heading.
- A fixed-height window showing up to four real queued actions.
- The existing Reject and Accept or Review controls on each visible action.
- An `Expand all actions` button.

The category-mix graphic, waiting count, and `to full auto` number are removed.

## Motion

Every few seconds, the stream rotates through the real queue:

1. The bottom visible action moves downward and fades out.
2. Existing visible actions settle one position lower.
3. The next real queued action enters from outside the upper-right edge.
4. The incoming card overshoots slightly and settles at the top.

The stream loops existing queued actions until the application receives new data. It never invents or duplicates a production recommendation. Motion pauses while the expanded list is open, while an action is being handled, when the tab is hidden, and when reduced motion is requested.

## Expanded List

`Expand all actions` opens the existing Calderyn modal treatment. It shows:

- Calibration percentage.
- Dollars at risk.
- Every real queued action in a static, non-rotating list.
- The same action controls and review routing as the stream.

Closing the modal resumes the stream.

## Data and Interactions

Calibration percentage comes from `liveEngine.calibrationPct`.

Dollars at risk keeps the current calculation from positive `dollar_impact` values in `app.actionQueue`.

Accept, Review, Reject, and group execution continue through the existing handlers. After a completed decision, the existing refresh path supplies the new queue, percentage, and dollars-at-risk value. The UI does not fabricate optimistic KPI values.

An empty queue keeps the existing `Nothing waiting. Calderyn is scanning.` state.

## Implementation Boundaries

- Change `app/components/dashboard/screens/Autopilot.tsx` and the smallest required Autopilot rules in `app/styles/dashboard.css`.
- Reuse `TickGauge`, existing buttons, the Calderyn modal treatment, Lucide registry icons, and current queue handlers.
- Add no dependency, chart library, route, API, loader, or server change.
- Leave the graduated Live Engine panel and Autopilot feature switchboard unchanged.

## Verification

- A focused UI test verifies top-entry order, bottom exit, expanded static list, and KPI refresh from changed application data.
- Reduced-motion mode shows a stable list without automatic animation.
- Existing Accept, Review, and Reject behavior remains reachable from both views.
- Run typecheck, lint, build, client-bundle verification, and a browser preview before release.
