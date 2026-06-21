// Resolve a concrete campaign target for shop-scoped ad_tax_overload alerts —
// whose entity_ref carries NO campaign_id — so autopilot can act on them.
// Deterministic v1 (spec §8): reuse the graded pool's worst-source pick. Returns
// a synthetic candidate in the SAME shape the candidate view produces, so
// runAutopilotForShop treats it identically. (SKU-scoped negative_unit_economics
// targeting is deferred: attribution_fact has no sku→campaign link — see spec §8.)
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickReallocation, type ReallocationCandidate } from "./reallocation-suggest.server";

interface ScopedAlert {
  id: string;
  detector_id: string;
  dollar_impact: number;
  entity_ref: Record<string, unknown>;
}

export interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number;
  campaign_id: string;
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
}

export async function resolveScopedCandidates(
  _shopId: string,
  alerts: ScopedAlert[],
  graded: ReallocationCandidate[],
  _sb: SupabaseClient,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const a of alerts) {
    if (a.detector_id !== "ad_tax_overload") continue; // v1: ad_tax_overload only
    const { source } = pickReallocation(graded); // worst-graded, never a winner
    if (!source) continue;
    out.push({
      alert_id: a.id,
      detector_id: a.detector_id,
      dollar_impact: a.dollar_impact,
      campaign_id: source.campaignId,
      campaign_spend_cents: source.dailyBudgetCents,
      daily_budget_cents: source.dailyBudgetCents,
    });
  }
  return out;
}
