// Weather-driven reallocation suggester. Pure ranking/sizing (buildSuggestion)
// plus DB glue (loadGeoSegmentedCampaigns / runWeatherSuggestForShop, below).
// Sizing lives HERE, not in the model or the approval route: the merchant's
// weather_sensitivity dial scales a move as a fraction of the source budget,
// bounded so it always leaves the source positive.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RegionCode } from "../ads/actions";
import { regionForGeoTargets } from "../ads/geo-regions";
import { favorability, type RegionForecast } from "../weather/score";
import {
  forecastPoints,
  merchantLocationFrom,
  type RegionCentroid,
} from "../weather/regions";
import { FORECAST_HORIZON_DAYS, fetchRegionForecasts } from "../weather/open-meteo.server";
import { isWeatherAuto } from "../weather/types";
import { executeReallocation } from "./reallocate.server";

export const SCORE_GAP_FLOOR = 0.15;
export const MAX_CUT_FRACTION = 0.9;
export const MIN_MOVE_CENTS = 100;

const plusDays = (isoDate: string, n: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface EligibleCampaign {
  campaignId: string;
  region: RegionCode;
  dailyBudgetCents: number;
  name: string;
}

export interface BuiltSuggestion {
  sourceRegion: RegionCode;
  destRegion: RegionCode;
  sourceCampaignId: string;
  destCampaignId: string;
  amountCents: number;
  sourceScore: number;
  destScore: number;
  narrative: string;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface ArmedTriggerRow {
  source_region: string;
  dest_region: string;
  expires_on: string;
}

export type ArmedVerdict = "execute" | "expire" | "hold";

/**
 * Decide what to do with an armed prediction against TODAY's fresh scores:
 * execute while the favorability gap that motivated the move still holds,
 * expire once the forecast window has passed, otherwise keep holding. A
 * missing fresh score means hold — never trigger on fabricated data.
 */
export function evaluateArmed(
  row: ArmedTriggerRow,
  scores: Map<RegionCode, number>,
  today: string,
): ArmedVerdict {
  if (today > row.expires_on) return "expire";
  const src = scores.get(row.source_region as RegionCode);
  const dst = scores.get(row.dest_region as RegionCode);
  if (src === undefined || dst === undefined) return "hold";
  return dst - src >= SCORE_GAP_FLOOR ? "execute" : "hold";
}

export function buildSuggestion(
  campaigns: EligibleCampaign[],
  scores: Map<RegionCode, number>,
  sensitivityPct: number,
): BuiltSuggestion | null {
  if (sensitivityPct <= 0) return null;

  const byRegion = new Map<RegionCode, EligibleCampaign[]>();
  for (const c of campaigns) {
    const list = byRegion.get(c.region) ?? [];
    list.push(c);
    byRegion.set(c.region, list);
  }
  if (byRegion.size < 2) return null;

  // Rank only regions we actually have a forecast score for. A campaign region
  // with no forecast entry (Open-Meteo returned fewer locations than points, or
  // the location was skipped for a missing daily series) would otherwise default
  // to score 0 — the minimum — and be chosen as the source whose budget is cut,
  // moving real money on a forecast we do not have.
  const ranked = [...byRegion.keys()]
    .filter((r) => scores.has(r))
    .sort((a, b) => scores.get(a)! - scores.get(b)!);
  if (ranked.length < 2) return null;
  const sourceRegion = ranked[0];
  const destRegion = ranked[ranked.length - 1];
  const sourceScore = scores.get(sourceRegion)!;
  const destScore = scores.get(destRegion)!;
  if (destScore - sourceScore < SCORE_GAP_FLOOR) return null;

  const pickBiggest = (r: RegionCode): EligibleCampaign =>
    byRegion.get(r)!.slice().sort((a, b) => b.dailyBudgetCents - a.dailyBudgetCents)[0];
  const source = pickBiggest(sourceRegion);
  const dest = pickBiggest(destRegion);

  const raw = Math.round(source.dailyBudgetCents * (sensitivityPct / 100) * (destScore - sourceScore));
  const capped = Math.min(raw, Math.floor(source.dailyBudgetCents * MAX_CUT_FRACTION));
  if (capped < MIN_MOVE_CENTS) return null;

  const narrative =
    `Next ${FORECAST_HORIZON_DAYS} days: ${destRegion} weather favors demand (score ${destScore.toFixed(2)}) ` +
    `vs ${sourceRegion} (${sourceScore.toFixed(2)}). Shift ${dollars(capped)}/day from ` +
    `"${source.name}" to "${dest.name}".`;

  return {
    sourceRegion, destRegion,
    sourceCampaignId: source.campaignId, destCampaignId: dest.campaignId,
    amountCents: capped, sourceScore, destScore, narrative,
  };
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  daily_budget_cents: number | null;
  geo_targets: string[] | null;
}

/** Load a shop's active, budgeted, single-region campaigns. */
export async function loadGeoSegmentedCampaigns(
  shopId: string,
  sb: SupabaseClient,
): Promise<EligibleCampaign[]> {
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id, name, status, daily_budget_cents, geo_targets")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .not("daily_budget_cents", "is", null);
  if (error) throw error;

  const out: EligibleCampaign[] = [];
  for (const c of (data ?? []) as CampaignRow[]) {
    // A $0/day campaign must not become a region's representative: as the
    // source giver it would zero out the whole move for the day.
    if (c.daily_budget_cents == null || c.daily_budget_cents <= 0) continue;
    const region = regionForGeoTargets(c.geo_targets ?? []);
    if (!region) continue;
    out.push({ campaignId: c.id, region, dailyBudgetCents: c.daily_budget_cents, name: c.name });
  }
  return out;
}

export interface RunDeps {
  fetchForecasts?: (points: readonly RegionCentroid[]) => Promise<Map<RegionCode, RegionForecast>>;
  today?: string;
}

export interface RunResult {
  suggested: number;
  skippedReason?:
    | "sensitivity_off"
    | "no_eligible_campaigns"
    | "no_suggestion"
    | "already_armed"
    | "already_suggested_today";
}

/**
 * Compute and upsert today's weather suggestion for one shop. Idempotent via the
 * unique (shop_id, suggested_on, source_campaign_id, dest_campaign_id) constraint.
 */
export async function runWeatherSuggestForShop(
  shopId: string,
  sb: SupabaseClient,
  deps: RunDeps = {},
): Promise<RunResult> {
  const { data: cfg, error: cfgErr } = await sb
    .from("guardrail_config")
    .select("weather_sensitivity, merchant_lat, merchant_lon")
    .eq("shop_id", shopId)
    .maybeSingle();
  // A failed config read must not be conflated with "feature off" — throw so
  // the cron counts the shop as failed instead of silently skipping it.
  if (cfgErr) throw cfgErr;
  const cfgRow = cfg as {
    weather_sensitivity?: unknown;
    merchant_lat?: unknown;
    merchant_lon?: unknown;
  } | null;
  const sensitivity = Number(cfgRow?.weather_sensitivity ?? 0);
  if (!(sensitivity > 0)) return { suggested: 0, skippedReason: "sensitivity_off" };
  const merchant = merchantLocationFrom(cfgRow);

  const campaigns = await loadGeoSegmentedCampaigns(shopId, sb);
  const regions = new Set(campaigns.map((c) => c.region));
  if (regions.size < 2) return { suggested: 0, skippedReason: "no_eligible_campaigns" };

  const fetchForecasts = deps.fetchForecasts ?? ((pts) => fetchRegionForecasts(pts));
  const forecasts = await fetchForecasts(forecastPoints(merchant));
  const scores = new Map<RegionCode, number>();
  for (const [region, f] of forecasts) scores.set(region, favorability(f));

  const suggestion = buildSuggestion(campaigns, scores, sensitivity);
  if (!suggestion) return { suggested: 0, skippedReason: "no_suggestion" };

  // A pair the merchant already armed (or that is mid-apply) must not be
  // re-proposed: a second live row would invite a manual apply alongside the
  // scheduled execution — two idempotency keys, one intended move, budget
  // moved twice — and would re-open the alert the arm just resolved.
  const { data: liveArmed, error: liveErr } = await sb
    .from("weather_suggestion")
    .select("id")
    .eq("shop_id", shopId)
    .eq("source_campaign_id", suggestion.sourceCampaignId)
    .eq("dest_campaign_id", suggestion.destCampaignId)
    .in("status", ["armed", "applying"])
    .limit(1);
  if (liveErr) throw liveErr;
  if ((liveArmed ?? []).length > 0) return { suggested: 0, skippedReason: "already_armed" };

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  // Dial at 100 = merchant opted into all-auto: predictions arm themselves and
  // execute unattended when the trigger verifies.
  const status = isWeatherAuto(sensitivity) ? "armed" : "pending";
  const { data: inserted, error } = await sb
    .from("weather_suggestion")
    .upsert(
      [
        {
          shop_id: shopId,
          suggested_on: today,
          source_region: suggestion.sourceRegion,
          dest_region: suggestion.destRegion,
          source_campaign_id: suggestion.sourceCampaignId,
          dest_campaign_id: suggestion.destCampaignId,
          amount_cents: suggestion.amountCents,
          source_score: suggestion.sourceScore,
          dest_score: suggestion.destScore,
          narrative: suggestion.narrative,
          status,
          expires_on: plusDays(today, FORECAST_HORIZON_DAYS),
        },
      ],
      {
        onConflict: "shop_id,suggested_on,source_campaign_id,dest_campaign_id",
        // ON CONFLICT DO NOTHING: a same-day re-run must never resurrect a row
        // the merchant already actioned (dismissed/applied/failed) or clobber a
        // live pending/armed one back to a fresh state.
        ignoreDuplicates: true,
      },
    )
    .select("id");
  if (error) throw error;
  const count = (inserted ?? []).length;
  // Nothing inserted → nothing to mirror either; re-opening the alert here
  // would resurrect a feed entry for a row the merchant already actioned.
  if (count === 0) return { suggested: 0, skippedReason: "already_suggested_today" };
  // Auto mode (born armed): the move needs no approval, so it must not open an
  // actionable alert — it lives on the Weather tab until the trigger fires.
  if (status === "armed") return { suggested: count };

  // Mirror the prediction into the alerts feed so it surfaces alongside the
  // other detectors. The active-alert dedup index (alerts_active_condition_key)
  // is PARTIAL, which PostgREST's ON CONFLICT cannot target (see
  // attribution/apply.server.ts) — so refresh the active row explicitly and
  // insert only when none exists. The cron is this detector's only writer, so
  // there is no concurrent-writer race.
  //
  // Rows are written against the BASE alerts schema — the UI reads
  // v_alerts_view, which derives title from entity_ref->>'title', the campaign
  // join from entity_ref->>'campaign_id', narrative from claude_narrative, and
  // evidence from the alert_context join.
  const entityRef = {
    kind: "weather_move",
    source_campaign_id: suggestion.sourceCampaignId,
    dest_campaign_id: suggestion.destCampaignId,
    campaign_id: suggestion.sourceCampaignId,
    title: `Weather favors ${suggestion.destRegion} — shift ${dollars(suggestion.amountCents)}/day`,
  };
  // The match key is the campaign pair only — title/campaign_id are display
  // fields that change with the amount, so lookups use jsonb containment.
  const matchRef = {
    kind: "weather_move",
    source_campaign_id: suggestion.sourceCampaignId,
    dest_campaign_id: suggestion.destCampaignId,
  };
  const evidence = {
    source_region: suggestion.sourceRegion,
    dest_region: suggestion.destRegion,
    source_score: suggestion.sourceScore,
    dest_score: suggestion.destScore,
    amount_cents_per_day: suggestion.amountCents,
    suggested_on: today,
    // Lets the Alerts detail act on the underlying prediction directly
    // (arm / apply / dismiss) instead of only deep-linking to the Weather tab.
    suggestion_id: String((inserted![0] as { id: unknown }).id),
  };
  const alertPatch = {
    severity: "low",
    // DB column is dollars; rowToAlert multiplies by 100 to get cents.
    dollar_impact: +(suggestion.amountCents / 100).toFixed(2),
    claude_narrative: suggestion.narrative,
    entity_ref: entityRef,
    day_bucket: today,
  };
  try {
    const { data: active, error: findErr } = await sb
      .from("alerts")
      .select("id")
      .eq("shop_id", shopId)
      .eq("detector_id", "weather_reallocation")
      .contains("entity_ref", matchRef)
      .in("status", ["open", "acknowledged", "snoozed"])
      .maybeSingle();
    if (findErr) throw findErr;
    if (active) {
      const { error: updErr } = await sb
        .from("alerts")
        .update({ ...alertPatch, last_seen_at: new Date().toISOString() })
        .eq("id", active.id)
        .eq("shop_id", shopId);
      if (updErr) throw updErr;
      const { error: ctxErr } = await sb
        .from("alert_context")
        .update({ evidence })
        .eq("alert_id", active.id)
        .eq("shop_id", shopId);
      if (ctxErr) throw ctxErr;
    } else {
      const { data: created, error: insErr } = await sb
        .from("alerts")
        .insert({
          shop_id: shopId,
          detector_id: "weather_reallocation",
          status: "open",
          claude_rank: 500,
          ...alertPatch,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      const { error: ctxErr } = await sb.from("alert_context").insert({
        alert_id: (created as { id: unknown }).id,
        shop_id: shopId,
        evidence,
      });
      if (ctxErr) throw ctxErr;
    }
  } catch (alertErr) {
    // Suggestion row is already written; a failed alert mirror must be loud
    // but must not roll back the prediction itself.
    console.error("[weather-suggest] alert mirror write failed", alertErr);
  }
  return { suggested: count };
}

/**
 * Resolve the active mirrored alert for a suggestion's campaign pair — called
 * when the suggestion reaches a terminal state (applied / dismissed / expired)
 * so the alerts feed never advertises a move that already happened or died.
 * Best-effort: an error is surfaced in logs but never fails the transition.
 */
export async function resolveWeatherAlert(
  sb: SupabaseClient,
  shopId: string,
  sourceCampaignId: string,
  destCampaignId: string,
): Promise<void> {
  // Containment, not equality: entity_ref also carries display fields
  // (title, campaign_id) that must not affect the match.
  const matchRef = {
    kind: "weather_move",
    source_campaign_id: sourceCampaignId,
    dest_campaign_id: destCampaignId,
  };
  const { error } = await sb
    .from("alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("detector_id", "weather_reallocation")
    .contains("entity_ref", matchRef)
    .in("status", ["open", "acknowledged", "snoozed"]);
  if (error) console.error("[weather-suggest] alert resolve failed", error);
}

interface ArmedRow {
  id: string;
  source_region: string;
  dest_region: string;
  source_campaign_id: string;
  dest_campaign_id: string;
  amount_cents: number;
  expires_on: string;
}

export interface ExecuteDeps {
  fetchForecasts?: (points: readonly RegionCentroid[]) => Promise<Map<RegionCode, RegionForecast>>;
  today?: string;
  /** Injectable executeReallocation; the sweep only consumes `.outcome`. */
  execute?: (
    shopId: string,
    input: Parameters<typeof executeReallocation>[1],
    sb: SupabaseClient,
  ) => Promise<{ outcome: string }>;
}

export interface ExecuteResult {
  executed: number;
  expired: number;
  held: number;
  failed: number;
}

/**
 * Sweep a shop's outstanding predictions against today's fresh forecasts:
 * execute armed rows whose favorability gap still holds, expire rows (armed
 * or pending) whose window passed, hold the rest. Turning the sensitivity
 * dial to 0 disarms: every armed row expires instead of executing — the dial
 * is the merchant's kill switch. Double-execution is impossible: each row is
 * atomically claimed (armed → applying) before any budget moves, and the
 * idempotency key is shared with the manual approval path.
 */
export async function runWeatherExecuteForShop(
  shopId: string,
  sb: SupabaseClient,
  deps: ExecuteDeps = {},
): Promise<ExecuteResult> {
  const result: ExecuteResult = { executed: 0, expired: 0, held: 0, failed: 0 };
  const today = deps.today ?? new Date().toISOString().slice(0, 10);

  // Retire pending rows that outlived their forecast window; without this the
  // table (and the loader's result set) grows by one orphan per day forever.
  // Resolve each row's mirrored alert too — an expired prediction must not
  // keep an open, actionable alert in the feed (its buttons would 409).
  const { data: staleRows, error: staleErr } = await sb
    .from("weather_suggestion")
    .update({ status: "expired" })
    .eq("shop_id", shopId)
    .eq("status", "pending")
    .lt("expires_on", today)
    .select("source_campaign_id, dest_campaign_id");
  if (staleErr) throw staleErr;
  for (const r of (staleRows ?? []) as Array<Record<string, unknown>>) {
    await resolveWeatherAlert(
      sb,
      shopId,
      String(r.source_campaign_id),
      String(r.dest_campaign_id),
    );
  }

  const { data: armedData, error: armedErr } = await sb
    .from("weather_suggestion")
    .select("id, source_region, dest_region, source_campaign_id, dest_campaign_id, amount_cents, expires_on")
    .eq("shop_id", shopId)
    .eq("status", "armed");
  if (armedErr) throw armedErr;
  const armed = (armedData ?? []) as ArmedRow[];
  if (armed.length === 0) return result;

  const { data: cfg, error: cfgErr } = await sb
    .from("guardrail_config")
    .select("weather_sensitivity, merchant_lat, merchant_lon")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cfgErr) throw cfgErr;
  const cfgRow = cfg as { weather_sensitivity?: unknown } | null;
  const sensitivity = Number(cfgRow?.weather_sensitivity ?? 0);

  // Conditional armed→<to> transition. Returns true when this call won the
  // row; false when someone else transitioned it first. Throws on a real
  // Supabase error — a failed write must never be mistaken for a lost race.
  const claimFromArmed = async (id: string, to: string): Promise<boolean> => {
    const { data, error } = await sb
      .from("weather_suggestion")
      .update({ status: to })
      .eq("id", id)
      .eq("shop_id", shopId)
      .eq("status", "armed")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return data != null;
  };

  const expireRow = async (row: ArmedRow) => {
    if (await claimFromArmed(row.id, "expired")) {
      result.expired += 1;
      await resolveWeatherAlert(sb, shopId, row.source_campaign_id, row.dest_campaign_id);
    }
  };

  // Dial at 0 = feature off: disarm everything outstanding, execute nothing.
  if (!(sensitivity > 0)) {
    for (const row of armed) await expireRow(row);
    return result;
  }

  const fetchForecasts = deps.fetchForecasts ?? ((pts) => fetchRegionForecasts(pts));
  const forecasts = await fetchForecasts(forecastPoints(merchantLocationFrom(cfg)));
  const scores = new Map<RegionCode, number>();
  for (const [region, f] of forecasts) scores.set(region, favorability(f));

  const execute = deps.execute ?? executeReallocation;

  for (const row of armed) {
    const verdict = evaluateArmed(row, scores, today);
    if (verdict === "hold") {
      result.held += 1;
      continue;
    }
    if (verdict === "expire") {
      await expireRow(row);
      continue;
    }

    // Atomic claim (armed → applying); a row someone else claimed yields false.
    if (!(await claimFromArmed(row.id, "applying"))) continue;

    const setStatus = async (status: string) => {
      const { error } = await sb
        .from("weather_suggestion")
        // applied_at feeds the panel's executed history (what ran, when).
        .update({ status, ...(status === "applied" ? { applied_at: new Date().toISOString() } : {}) })
        .eq("id", row.id)
        .eq("shop_id", shopId);
      // Budget may already have moved — a stranded 'applying' row is invisible
      // to both the sweep and the UI, so this must be loud (rule: fail visibly).
      if (error) console.error(`[weather-execute] status→${status} failed for ${row.id}`, error);
    };

    let outcome: string;
    try {
      const res = await execute(
        shopId,
        {
          alertId: null,
          sourceCampaignId: row.source_campaign_id,
          destCampaignId: row.dest_campaign_id,
          amountCents: row.amount_cents,
          idempotencyKey: `weather:${row.id}`,
          actor: "autopilot",
          triggerReason: "weather_armed",
        },
        sb,
      );
      outcome = res.outcome;
    } catch (err) {
      // A throw can land AFTER the budgets were already moved on-platform but
      // BEFORE the idempotency record was written (executeReallocation mutates
      // budgets first, then insertAuditWithIdempotency can still throw).
      // Releasing back to 'armed' would let tomorrow's sweep re-claim and move
      // the budget a SECOND time — priorExecutionForKey finds no record. Not
      // safely retryable: terminal 'failed', same as the manual-apply route.
      console.error(`[weather-execute] execute threw for ${row.id}`, err);
      await setStatus("failed");
      result.failed += 1;
      continue;
    }
    if (outcome === "failed") {
      // Permanent failure with the idempotency key consumed — terminal.
      await setStatus("failed");
      result.failed += 1;
      continue;
    }
    await setStatus("applied");
    await resolveWeatherAlert(sb, shopId, row.source_campaign_id, row.dest_campaign_id);
    result.executed += 1;
  }
  return result;
}
