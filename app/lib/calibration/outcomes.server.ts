// Read closed-window per-action rewards from action_audit and fold them into
// per-(detector, action) outcome tallies. The detector comes from the joined
// alert (action_audit has no detector_id column). Rows with no alert/detector
// cannot map to a calibration pair and are skipped. NEVER throws.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tallyOutcomes, type OutcomeRow, type OutcomeTally } from "./outcomes";

interface AuditRewardRow {
  action_kind: string;
  reward_signal: number | null;
  reward_window_closed_at: string | null;
  alerts: { detector_id: string | null } | null;
}

export async function loadPairOutcomeTallies(
  shopId: string,
  sb: SupabaseClient,
): Promise<Map<string, OutcomeTally>> {
  try {
    const { data, error } = await sb
      .from("action_audit")
      .select("action_kind, reward_signal, reward_window_closed_at, alerts!inner(detector_id)")
      .eq("shop_id", shopId)
      .not("reward_window_closed_at", "is", null);
    if (error) {
      console.error(`[calibration] loadPairOutcomeTallies read failed: ${error.message}`);
      return new Map();
    }
    const byPair = new Map<string, OutcomeRow[]>();
    for (const r of (data ?? []) as unknown as AuditRewardRow[]) {
      const detector = r.alerts?.detector_id;
      if (!detector || r.reward_signal == null || r.reward_window_closed_at == null) continue;
      const key = `${detector}:${r.action_kind}`;
      const arr = byPair.get(key) ?? [];
      arr.push({ signal: Number(r.reward_signal), closedAt: r.reward_window_closed_at });
      byPair.set(key, arr);
    }
    const out = new Map<string, OutcomeTally>();
    for (const [key, rows] of byPair) out.set(key, tallyOutcomes(rows));
    return out;
  } catch (err) {
    console.error(
      `[calibration] loadPairOutcomeTallies threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
}
