// Maps an autopilot run's LANDED decisions to one notification line each — the
// "small notif every time something executes" both surfaces show on load: the
// web dashboard pops one toast per line (ToastHost), the embedded Shopify admin
// lists the lines in a Polaris Banner (app._index). Pure (no React, no fetch),
// surface-agnostic, so it lives in lib/ and is unit-tested directly.
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

// Lowercase verbs for the "Couldn't <verb> <campaign>" failure phrasing, keyed by
// the kind the engine TRIED (decision.intendedKind) — a failed decision's `reason`
// is a technical string ("executor outcome: failed" / "threw: …"), not a kind.
const FAILED_VERBS: Record<string, string> = {
  pause_campaign: "pause",
  reduce_campaign_budget: "lower the budget on",
  reallocate_budget: "reallocate budget from",
  increase_campaign_budget: "scale",
};

/**
 * One line per decision that FAILED at the executor (`outcome === "failed"`) — the
 * "fail visibly" half of the on-load banner (rule 12). Without this a failed run
 * (e.g. a dead Google Ads token) is silent and reads as "autopilot did nothing".
 * The technical reason lives in Action history; this line just names what couldn't
 * be done so the merchant knows to look.
 */
export function autopilotFailureLines(
  decisions: AutopilotDecisionVM[],
  campaignName: (id: string) => string,
): string[] {
  return decisions
    .filter((d) => d.outcome === "failed")
    .map((d) => {
      const verb = FAILED_VERBS[d.intendedKind ?? ""] ?? "act on";
      const name = campaignName(d.campaignId).trim() || "a campaign";
      return `Couldn't ${verb} ${name}`;
    });
}
