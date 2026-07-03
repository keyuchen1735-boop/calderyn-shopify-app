// One definition of "the engine has nothing to work with yet", shared by every
// surface that renders an Autopilot zero-state. Split predicates per surface
// drift and contradict each other (one screen "Standing by" while its neighbor
// shows a calibration score for the same shop).
import type { DashboardCtx } from "./context";

export function hasEngineSignals(
  app: Pick<DashboardCtx, "campaigns" | "actionQueue" | "audit">,
): boolean {
  return app.campaigns.length > 0 || app.actionQueue.length > 0 || app.audit.length > 0;
}
