// Read-only aggregation for the Live Engine "autopilot is running" panel:
// the graduated (detector, action) pairs that run unattended, each pair's
// autonomous-action money/count/last-action, the shop-level autopilot flag, and
// the total money protected this week. Best-effort: returns empty/zero on any
// read error so the page degrades to a calm state instead of throwing.
//
// The pure aggregation (`aggregateLiveEngine`) is split out so it can be
// unit-tested without a Supabase client. `dollar_impact_at_exec` is stored in
// DOLLARS in action_audit (see rowToAudit in calderyn.server.ts), so it is
// converted to cents here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import { DETECTOR_LABELS, featureLabel } from "../labels";
import { NO_BRAINER } from "./confidence";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;

export interface LiveEngineFeature {
  detectorId: string;
  actionKind: ActionKind;
  /** Action label, e.g. "Pause campaign" — the thing Calderyn does unattended. */
  name: string;
  /** Detector label, e.g. "Campaign is losing money" — what it watches for. */
  watching: string;
  /** Per-feature autonomy on (true) or paused by the merchant (false). */
  enabled: boolean;
  /** Money this feature protected via autonomous actions in the window (cents). */
  moneyCents: number;
  /** Autonomous actions taken in the window. */
  actions: number;
  /** ISO timestamp of the most recent autonomous action, or null if none yet. */
  lastAt: string | null;
}

export interface LiveEngineSummary {
  autopilotEnabled: boolean;
  moneyProtectedWeekCents: number;
  features: LiveEngineFeature[];
}

export interface PairRow {
  detector_id: string;
  action_kind: string;
  merchant_disabled?: boolean | null;
  graduated?: boolean | null;
}

/**
 * A single (detector, action) pair's Beta evidence + graduation gate, used to
 * compute confidence breakdowns for the Live Engine pipeline + inspector. Covers
 * ALL pairs (not just graduated), since the pipeline shows pairs still being
 * learned. graduationThreshold is the real per-pair auto-act bar (not a hardcode).
 */
export interface PairEvidence {
  detectorId: string;
  actionKind: ActionKind;
  alpha: number;
  beta: number;
  graduationThreshold: number;
  graduated: boolean;
}

export interface AutopilotAuditRow {
  detector_id: string;
  action_kind: string;
  /** Stored in dollars (converted to cents here). */
  dollar_impact_at_exec: number | string | null;
  created_at: string;
}

/**
 * Pure: fold graduated pairs + autonomous audit rows into the Live Engine view.
 * `auditRows` MUST already be filtered to actor=autopilot, outcome=succeeded,
 * undo_of=null (the query does that); this just aggregates them per pair.
 */
export function aggregateLiveEngine(
  pairs: PairRow[],
  auditRows: AutopilotAuditRow[],
  nowMs: number,
): { moneyProtectedWeekCents: number; features: LiveEngineFeature[] } {
  const weekStart = nowMs - 7 * DAY_MS;
  const agg = new Map<string, { money: number; actions: number; lastAt: string | null }>();
  let moneyWeek = 0;

  for (const r of auditRows) {
    const cents = Math.round(Number(r.dollar_impact_at_exec ?? 0) * 100);
    const key = `${r.detector_id}:${r.action_kind}`;
    const cur = agg.get(key) ?? { money: 0, actions: 0, lastAt: null };
    cur.money += cents;
    cur.actions += 1;
    if (!cur.lastAt || r.created_at > cur.lastAt) cur.lastAt = r.created_at;
    agg.set(key, cur);
    const t = new Date(r.created_at).getTime();
    if (Number.isFinite(t) && t >= weekStart) moneyWeek += cents;
  }

  const features: LiveEngineFeature[] = pairs.map((p) => {
    const detectorId = String(p.detector_id);
    const actionKind = p.action_kind as ActionKind;
    const a = agg.get(`${detectorId}:${actionKind}`) ?? { money: 0, actions: 0, lastAt: null };
    return {
      detectorId,
      actionKind,
      name: featureLabel(detectorId, actionKind),
      watching: DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId,
      enabled: !p.merchant_disabled,
      moneyCents: a.money,
      actions: a.actions,
      lastAt: a.lastAt,
    };
  });

  // Most active first, then most recently acted, then a stable key. The final
  // tiebreak is essential: freshly shipped pairs all have moneyCents 0 / lastAt
  // null, so without it the order falls back to the DB's (non-deterministic)
  // row order and the list reshuffles every time a pair is toggled.
  features.sort(
    (x, y) =>
      y.moneyCents - x.moneyCents ||
      (y.lastAt ?? "").localeCompare(x.lastAt ?? "") ||
      `${x.detectorId}:${x.actionKind}`.localeCompare(`${y.detectorId}:${y.actionKind}`),
  );

  return { moneyProtectedWeekCents: moneyWeek, features };
}

export async function liveEngineSummary(shopId: string, sb: SupabaseClient): Promise<LiveEngineSummary> {
  const empty: LiveEngineSummary = { autopilotEnabled: false, moneyProtectedWeekCents: 0, features: [] };
  try {
    const { data: shopRow } = await sb
      .from("shops")
      .select("autopilot_enabled")
      .eq("id", shopId)
      .maybeSingle();
    const autopilotEnabled = Boolean(shopRow?.autopilot_enabled);

    const { data: pairRows, error: pairErr } = await sb
      .from("pair_calibration")
      .select("detector_id, action_kind, merchant_disabled, graduated")
      .eq("shop_id", shopId);
    const visiblePairs = ((pairRows ?? []) as PairRow[]).filter(
      (row) =>
        Boolean(row.graduated) ||
        NO_BRAINER.has(`${row.detector_id}:${row.action_kind}`),
    );
    if (pairErr || visiblePairs.length === 0) {
      return { autopilotEnabled, moneyProtectedWeekCents: 0, features: [] };
    }

    // Autonomous actions are read from v_audit_view, NOT the raw action_audit
    // table: detector_id (LEFT JOIN alerts) and actor (= COALESCE(actor_user_id,
    // 'system')) are view-only projections — the raw table has neither column.
    // Autopilot writes actor_user_id='autopilot' (see autopilot.server.ts /
    // execute.server.ts), which the same filter guardrails.server.ts uses to tally
    // today's autonomous spend. dollar_impact_at_exec is in DOLLARS in the view;
    // aggregateLiveEngine converts to cents. undo_of=null drops reversal rows.
    const sinceIso = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString();
    const { data: auditRows } = await sb
      .from("v_audit_view")
      .select("detector_id, action_kind, dollar_impact_at_exec, created_at")
      .eq("shop_id", shopId)
      .eq("actor", "autopilot")
      .eq("outcome", "succeeded")
      .is("undo_of", null)
      .gte("created_at", sinceIso);

    const { moneyProtectedWeekCents, features } = aggregateLiveEngine(
      visiblePairs,
      (auditRows ?? []) as AutopilotAuditRow[],
      Date.now(),
    );
    return { autopilotEnabled, moneyProtectedWeekCents, features };
  } catch {
    return empty;
  }
}

/**
 * Turn a feature's unattended autonomy on/off for this shop by flipping
 * pair_calibration.merchant_disabled. DISABLING is always safe: the pair simply
 * falls back to asking you in the Action Queue. ENABLING only takes effect for a
 * pair that is actually graduated AND while the shop-level autopilot flag is on,
 * so the graduation gate (not this flag) remains the real authority. Scoped to
 * the shop. Best-effort: returns {ok:false} on error, never throws.
 */
export async function setPairAutonomy(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  enabled: boolean,
  sb: SupabaseClient,
): Promise<{ ok: boolean }> {
  try {
    const shipped = NO_BRAINER.has(`${detectorId}:${actionKind}`);
    const { error } = await sb
      .from("pair_calibration")
      .update({
        merchant_disabled: !enabled,
        ...(shipped ? { graduated: enabled } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("shop_id", shopId)
      .eq("detector_id", detectorId)
      .eq("action_kind", actionKind);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
