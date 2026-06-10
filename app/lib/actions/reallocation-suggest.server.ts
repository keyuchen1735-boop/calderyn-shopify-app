// Grade-driven source/destination suggestion for budget reallocation, shared
// by the campaigns UI loader and autopilot so both surfaces pick identically.
// Source: the worst-graded active daily-budgeted campaign (never a winner).
// Dest: the highest-ROAS `winning` campaign on a DIFFERENT platform, or null —
// callers fall back rather than force a bad pick.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";

export interface ReallocationCandidate {
  campaignId: string; // ad_campaign_dim uuid
  externalId: string;
  platform: Platform;
  name: string;
  dailyBudgetCents: number;
  grade: "winning" | "okay" | "poor";
  roas: number;
}

export interface ReallocationSuggestion {
  source: ReallocationCandidate | null;
  dest: ReallocationCandidate | null;
}

const GRADE_RANK: Record<string, number> = { poor: 0, okay: 1, winning: 2 };

// Grade history grows one row per campaign per day; with day_bucket-desc
// ordering the cap trims the oldest rows first. A campaign whose latest grade
// has aged past the cap window loses its grade and drops out of candidacy —
// acceptable: a grade that stale shouldn't drive money moves.
export const GRADE_ROWS_CAP = 1000;

interface CampaignRow {
  id: string;
  external_id: string;
  platform: string;
  name: string;
  daily_budget_cents: number | null;
}

interface GradeRow {
  campaign_id: string;
  grade: string;
  roas: number | string;
  day_bucket: string;
}

/**
 * Load the candidate pool: every active daily-budgeted campaign joined with
 * its latest grade. One read pair serves any number of pickReallocation calls
 * (autopilot hoists this out of its per-candidate loop).
 */
export async function loadReallocationCandidates(
  shopId: string,
  sb: SupabaseClient,
): Promise<ReallocationCandidate[]> {
  const { data: campRows, error: cErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id, platform, name, daily_budget_cents")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .not("daily_budget_cents", "is", null);
  if (cErr) throw cErr;
  const campaigns = (campRows ?? []) as CampaignRow[];
  if (campaigns.length === 0) return [];

  const { data: gradeRows, error: gErr } = await sb
    .from("campaign_grade_fact")
    .select("campaign_id, grade, roas, day_bucket")
    .eq("shop_id", shopId)
    .order("day_bucket", { ascending: false })
    .limit(GRADE_ROWS_CAP);
  if (gErr) throw gErr;
  // Rows are day_bucket-desc, so the first row seen per campaign is its latest.
  const latest = new Map<string, GradeRow>();
  for (const g of (gradeRows ?? []) as GradeRow[]) {
    if (!latest.has(g.campaign_id)) latest.set(g.campaign_id, g);
  }

  const graded: ReallocationCandidate[] = [];
  for (const c of campaigns) {
    const g = latest.get(c.id);
    if (!g || c.daily_budget_cents == null || GRADE_RANK[g.grade] == null) continue;
    graded.push({
      campaignId: c.id,
      externalId: c.external_id,
      platform: c.platform as Platform,
      name: c.name,
      dailyBudgetCents: c.daily_budget_cents,
      grade: g.grade as ReallocationCandidate["grade"],
      roas: Number(g.roas),
    });
  }
  return graded;
}

/**
 * Pick source and destination from a pre-loaded candidate pool.
 * NOTE: a PINNED sourceCampaignId is returned even if graded winning — the caller owns that judgment (autopilot pins the alert's campaign; the guardrail cut-cap still applies).
 */
export function pickReallocation(
  graded: ReallocationCandidate[],
  opts: { sourceCampaignId?: string } = {},
): ReallocationSuggestion {
  let source: ReallocationCandidate | null = null;
  if (opts.sourceCampaignId) {
    source = graded.find((c) => c.campaignId === opts.sourceCampaignId) ?? null;
  } else {
    // Worst grade first, lowest ROAS breaking ties; never drain a winner.
    const ranked = graded
      .slice()
      .sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || a.roas - b.roas);
    source = ranked.length > 0 && ranked[0].grade !== "winning" ? ranked[0] : null;
  }
  if (!source) return { source: null, dest: null };

  const src = source;
  const dest =
    graded
      .filter(
        (c) =>
          c.grade === "winning" &&
          c.platform !== src.platform &&
          c.campaignId !== src.campaignId,
      )
      .sort((a, b) => b.roas - a.roas)[0] ?? null;
  return { source, dest };
}

/** Suggest source and destination campaigns for a budget reallocation. */
export async function suggestReallocation(
  shopId: string,
  sb: SupabaseClient,
  opts: { sourceCampaignId?: string } = {},
): Promise<ReallocationSuggestion> {
  return pickReallocation(await loadReallocationCandidates(shopId, sb), opts);
}
