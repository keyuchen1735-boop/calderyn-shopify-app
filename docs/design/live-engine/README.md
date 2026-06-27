# Live Engine — imported design reference

Canonical design lives in the claude.ai Design project
`3fae1b7a-423f-4bb9-8441-9239db64d3bc` and is read via the claude_design MCP
(DesignSync `get_file`). Pixel/motion source of truth = the `.dc.html` bundles;
they run on a prototype runtime (`support.js`) that is **never** shipped.

## Files in the design project
- `Calderyn Webapp.dc.html` — full app; only the Overview (`data-screen="dashboard"`,
  ~lines 474–622) + sidebar + page header are in scope.
- `design_handoff_live_engine/` — curated handoff: `README.md`, `AutopilotHero.dc.html`,
  `css/dashboard.css`, `css/dashboard-utils.css`, `support.js` (prototype only).
- `live-engine-kit/` — per-component references: `AutopilotHero`, `CalibrationRing`,
  `ConfidenceGauge`, `FactorBars`, `FeatureToggleRow`, `HeroAurora`, `InspectorPanel`,
  `LiveBadge`, `PredictionRow`, `ReasoningStream`, `SubagentSwarm`, `TraceRow`.
- `screenshots/` — reference captures of states/variants.

## How implementation uses this
The build spec is `docs/superpowers/specs/2026-06-26-live-engine-overview-design.md`.
During implementation, pull each `.dc.html`/`.css` with DesignSync `get_file` and
translate to the repo's real components (dashboard: `app/components/dashboard/*`;
embedded: Polaris `app/components/calderyn/*`). Match look/motion pixel-for-pixel;
replace the prototype's looped fake data + `window` CustomEvents with real engine
state and real endpoint responses. Do not commit `support.js` or any `.dc.html` to
the browser bundle.
