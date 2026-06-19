// Maps an autopilot run's LANDED decisions to one notification banner each — the
// "small notif every time something executes" the dashboard pops on load. Pure
// (no React, no fetch) so it is unit-tested directly.
//
// Self-contained verb map: ACTION_LABELS (format.ts) omits increase_campaign_budget
// and reallocate_budget, both of which autopilot lands, so keying off it would
// silently drop those banners. The keys here are the executed kinds autopilot
// records as a decision's `reason` (see record()/decide() in autopilot.server.ts).

/** Browser-safe shape of one AutopilotDecision (autopilot.server.ts). */
export interface AutopilotDecisionVM {
  campaignId: string;
  detectorId: string;
  intendedKind: string | null;
  outcome: string; // "acted" | "blocked" | "skipped" | "failed"
  reason: string; // for an acted decision: the executed kind
}

export interface BannerToast {
  text: string;
  icon: string;
  tone: string;
}

// Past-tense, autopilot-voice verbs keyed by the executed kind.
const AUTOPILOT_VERBS: Record<string, string> = {
  pause_campaign: "Auto-paused",
  reduce_campaign_budget: "Auto-reduced budget on",
  reallocate_budget: "Auto-reallocated budget from",
  increase_campaign_budget: "Auto-scaled budget on",
};

/**
 * One banner per decision that actually landed (`outcome === "acted"`), in the
 * order autopilot executed them. `campaignName(id)` resolves the campaign's
 * display name; an unknown/empty name falls back to a generic noun so a banner
 * never reads "Auto-paused " with a dangling target.
 */
export function autopilotToasts(
  decisions: AutopilotDecisionVM[],
  campaignName: (id: string) => string,
): BannerToast[] {
  return decisions
    .filter((d) => d.outcome === "acted")
    .map((d) => {
      const verb =
        AUTOPILOT_VERBS[d.reason] ?? AUTOPILOT_VERBS[d.intendedKind ?? ""] ?? "Autopilot acted on";
      const name = campaignName(d.campaignId).trim() || "a campaign";
      return { text: `${verb} ${name}`, icon: "bolt", tone: "accent" };
    });
}
