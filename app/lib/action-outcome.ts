// How an executed action's terminal outcome maps to merchant-facing UI: whether
// the alert may be resolved / the optimistic state applied, and what to tell the
// merchant. The dashboard SPA consumes this directly; the embedded admin
// enforces the SAME contract in its own server-side action handlers
// (app/routes/app.alerts.$id.tsx, app/routes/app.campaigns._index.tsx) — keep
// the two in agreement.
//
// P0-1: a `retrying` or `failed` action is NEVER a success — it must not show a
// success toast, must not flip the alert to resolved, and must not apply the
// optimistic post-state. Only `succeeded` does. This module is client-safe (no
// *.server import) so the dashboard SPA can use it directly.

export type ActionOutcome = "succeeded" | "failed" | "retrying";

export interface ActionOutcomeView {
  /** The action terminally succeeded. ONLY then may the UI resolve/acknowledge
   *  the alert and apply the optimistic post-state (paused / new budget). */
  succeeded: boolean;
  /** A terminal failure the merchant must see as an error. `retrying` is NOT an
   *  error — it is queued for automatic retry. */
  isError: boolean;
  /** Merchant-facing toast text. `label` is the action's plain verb
   *  (e.g. "Pause campaign"). */
  message: string;
}

/**
 * Map a server-reported action outcome to its UI presentation. Accepts a raw
 * string (the API types `outcome` as string) and treats anything other than the
 * two known non-terminal-failure states as a failure — an unknown outcome must
 * never be presented as a false success.
 */
export function presentActionOutcome(outcome: string, label: string): ActionOutcomeView {
  switch (outcome) {
    case "succeeded":
      return { succeeded: true, isError: false, message: `${label} — done. Logged to action history.` };
    case "retrying":
      return {
        succeeded: false,
        isError: false,
        message: `${label} — couldn't reach the ad platform; queued and will retry automatically.`,
      };
    default:
      return {
        succeeded: false,
        isError: true,
        message: `${label} couldn't be completed — see the action history for details.`,
      };
  }
}
