// Persistence for radar_ploy (merchant label: "move") and radar_state. Service
// role client, shop_id threaded on every query; snake_case never escapes this
// module. The partial unique index (shop_id, kind, dedup_key) WHERE draft is
// the dedup backstop - insertDraftMove treats 23505 as "someone else won".
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import type { RadarCandidate, RadarEvidence, RadarMoveKind, RadarMoveRow, RadarMoveStatus } from "./types";

export const DISMISS_COOLDOWN_DAYS = 30;
export const EXPIRE_COOLDOWN_DAYS = 14;
/** Judgment call (spec is silent): a just-applied fix must not re-draft off
 *  lagged data the very next night. */
export const APPLY_COOLDOWN_DAYS = 14;

const DAY_MS = 86_400_000;
const MOVE_COLUMNS =
  "id, shop_id, kind, status, headline, rationale, evidence, payload, dedup_key, " +
  "prior_state, applied_state_hash, created_at, applied_at, resolved_at, expires_at";

function mapRow(r: Record<string, unknown>): RadarMoveRow {
  return {
    id: String(r.id),
    shopId: String(r.shop_id),
    kind: r.kind as RadarMoveKind,
    status: r.status as RadarMoveStatus,
    headline: String(r.headline),
    rationale: String(r.rationale),
    evidence: (r.evidence ?? { chips: [], facts: {} }) as RadarEvidence,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    dedupKey: String(r.dedup_key),
    priorState: (r.prior_state as Record<string, unknown> | null) ?? null,
    appliedStateHash: (r.applied_state_hash as string | null) ?? null,
    createdAt: String(r.created_at),
    appliedAt: (r.applied_at as string | null) ?? null,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    expiresAt: String(r.expires_at),
  };
}

export async function insertDraftMove(shopId: string, c: RadarCandidate): Promise<"inserted" | "duplicate"> {
  if (!isUuid(shopId)) throw new Error(`insertDraftMove requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("radar_ploy").insert({
    shop_id: shopId,
    kind: c.kind,
    status: "draft",
    headline: c.headline,
    rationale: c.rationale,
    evidence: c.evidence,
    payload: c.payload,
    dedup_key: c.dedupKey,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw new Error(`insertDraftMove: ${error.message}`);
  }
  return "inserted";
}

export async function listMoves(
  shopId: string,
  statuses: RadarMoveStatus[],
  limit = 50,
): Promise<RadarMoveRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .select(MOVE_COLUMNS)
    .eq("shop_id", shopId)
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listMoves: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Recent rows across ALL statuses for the drafter's cooldown checks. */
export async function listRecentMoveRows(shopId: string, sinceDays = 45): Promise<RadarMoveRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .select(MOVE_COLUMNS)
    .eq("shop_id", shopId)
    .gte("created_at", new Date(Date.now() - sinceDays * DAY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`listRecentMoveRows: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

export async function getMove(shopId: string, moveId: string): Promise<RadarMoveRow | null> {
  if (!isUuid(shopId) || !isUuid(moveId)) return null;
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .select(MOVE_COLUMNS)
    .eq("shop_id", shopId)
    .eq("id", moveId)
    .maybeSingle();
  if (error) throw new Error(`getMove: ${error.message}`);
  return data ? mapRow(data as unknown as Record<string, unknown>) : null;
}

/**
 * @param expectedStatus When given, the write is conditioned on the row's current status matching
 * (`.eq("status", expectedStatus)`) so a status-changing transition (e.g. draft -> applied) can't
 * silently clobber a concurrent transition that landed first. Returns whether the row was actually
 * updated - callers that pass expectedStatus must check it; callers that omit it always get true.
 */
export async function updateMove(
  shopId: string,
  moveId: string,
  patch: Partial<{
    status: RadarMoveStatus;
    appliedAt: string | null;
    resolvedAt: string | null;
    priorState: Record<string, unknown> | null;
    appliedStateHash: string | null;
    payload: Record<string, unknown>;
  }>,
  expectedStatus?: RadarMoveStatus,
): Promise<boolean> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.appliedAt !== undefined) row.applied_at = patch.appliedAt;
  if (patch.resolvedAt !== undefined) row.resolved_at = patch.resolvedAt;
  if (patch.priorState !== undefined) row.prior_state = patch.priorState;
  if (patch.appliedStateHash !== undefined) row.applied_state_hash = patch.appliedStateHash;
  if (patch.payload !== undefined) row.payload = patch.payload;
  const query = getSupabase()
    .from("radar_ploy")
    .update(row)
    .eq("shop_id", shopId)
    .eq("id", moveId);
  if (expectedStatus === undefined) {
    const { error } = await query;
    if (error) throw new Error(`updateMove: ${error.message}`);
    return true;
  }
  const { data, error } = await query.eq("status", expectedStatus).select("id");
  if (error) throw new Error(`updateMove: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Sweep open drafts past expires_at. Returns how many were expired. */
export async function expireStaleMoves(shopId: string, now: Date = new Date()): Promise<number> {
  if (!isUuid(shopId)) return 0;
  const { data, error } = await getSupabase()
    .from("radar_ploy")
    .update({ status: "expired", resolved_at: now.toISOString() })
    .eq("shop_id", shopId)
    .eq("status", "draft")
    .lt("expires_at", now.toISOString())
    .select("id");
  if (error) throw new Error(`expireStaleMoves: ${error.message}`);
  return (data ?? []).length;
}

/** Pure cooldown rule: a candidate is blocked while an open draft exists, or
 *  within 30 days of a dismissal / 14 days of an expiry / 14 days of an apply
 *  on the same (kind, dedup_key). */
export function isCoolingDown(
  rows: RadarMoveRow[],
  candidate: Pick<RadarCandidate, "kind" | "dedupKey">,
  now: Date = new Date(),
): boolean {
  const t = now.getTime();
  for (const r of rows) {
    if (r.kind !== candidate.kind || r.dedupKey !== candidate.dedupKey) continue;
    if (r.status === "draft") return true;
    if (r.status === "dismissed" && r.resolvedAt
      && t - Date.parse(r.resolvedAt) < DISMISS_COOLDOWN_DAYS * DAY_MS) return true;
    if (r.status === "expired" && r.resolvedAt
      && t - Date.parse(r.resolvedAt) < EXPIRE_COOLDOWN_DAYS * DAY_MS) return true;
    if (r.status === "applied" && r.appliedAt
      && t - Date.parse(r.appliedAt) < APPLY_COOLDOWN_DAYS * DAY_MS) return true;
  }
  return false;
}

export interface RadarState {
  lastCollectedAt: string | null;
  lastDraftedAt: string | null;
  homeCardDismissedAt: string | null;
}

export async function readRadarState(shopId: string): Promise<RadarState> {
  if (!isUuid(shopId)) return { lastCollectedAt: null, lastDraftedAt: null, homeCardDismissedAt: null };
  const { data, error } = await getSupabase()
    .from("radar_state")
    .select("last_collected_at, last_drafted_at, home_card_dismissed_at")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`readRadarState: ${error.message}`);
  return {
    lastCollectedAt: (data?.last_collected_at as string | null) ?? null,
    lastDraftedAt: (data?.last_drafted_at as string | null) ?? null,
    homeCardDismissedAt: (data?.home_card_dismissed_at as string | null) ?? null,
  };
}

export async function stampRadarState(
  shopId: string,
  patch: Partial<{ lastCollectedAt: string; lastDraftedAt: string; homeCardDismissedAt: string }>,
): Promise<void> {
  if (!isUuid(shopId)) return;
  const row: Record<string, unknown> = { shop_id: shopId, updated_at: new Date().toISOString() };
  if (patch.lastCollectedAt !== undefined) row.last_collected_at = patch.lastCollectedAt;
  if (patch.lastDraftedAt !== undefined) row.last_drafted_at = patch.lastDraftedAt;
  if (patch.homeCardDismissedAt !== undefined) row.home_card_dismissed_at = patch.homeCardDismissedAt;
  const { error } = await getSupabase().from("radar_state").upsert(row, { onConflict: "shop_id" });
  if (error) throw new Error(`stampRadarState: ${error.message}`);
}
