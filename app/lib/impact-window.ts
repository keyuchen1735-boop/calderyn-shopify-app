// Canonical window for an alert's dollar_impact. Detectors project impact over
// the NEXT 30 DAYS if nothing changes (see app/lib/assistant/prompt.server.ts),
// so every surface must label it as a 30-day figure. The dashboard previously
// rendered "/wk" for the same value (P1-5) — one definition here, both surfaces
// consume it so the amount and its window label can never drift apart. Plain
// module (no UI deps) so the embedded admin and the dashboard SPA can share it.

export const IMPACT_WINDOW_DAYS = 30;
export const IMPACT_LABEL = "Projected 30-day impact";
export const IMPACT_SUFFIX = "/30d";
export const IMPACT_METHODOLOGY =
  "Estimated from this alert's evidence — current spend, margin-adjusted return, and sales velocity — projected over the next 30 days if nothing changes. An estimate, not a guarantee; the audit log records the realized impact after you act.";
