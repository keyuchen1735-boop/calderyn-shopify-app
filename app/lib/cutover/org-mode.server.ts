// Cutover org_mode state machine + DB enforcer (platform pivot Step 9). Server-only:
// reaches Postgres through the service-role client (getSupabase, BYPASSRLS), threading
// shop_id explicitly on every read/write. Mirrors the order spine (order.server.ts +
// state.ts): the legal-transition set is the single source of truth, transitionOrgMode
// inserts one append-only cutover_transition audit row BEFORE the shops UPDATE, and the
// UPDATE is a compare-and-set on the from-mode so a concurrent transition can't be
// silently overwritten. writesToOwned is the router predicate the store executors branch
// on: only `live` routes autopilot writes to Calderyn's own tables.

import { getSupabase } from "~/lib/supabase.server";
import { assertGoLiveGates, stampMigrationRunCutover } from "./go-live.server";
import { refundTestOrders } from "./test-transaction.server";
import { CutoverBlockedError } from "./errors";

export const ORG_MODES = ["mirror", "importing", "dual_run", "live"] as const;
export type OrgMode = (typeof ORG_MODES)[number];

export interface CutoverTransition {
  id: string;
  shopId: string;
  fromMode: OrgMode;
  toMode: OrgMode;
  reason: string | null;
  occurredAt: string;
}

// Adjacency list of LEGAL transitions. Anything not listed is illegal — including
// identity moves and any jump (mirror->live). Keyed exhaustively over OrgMode so a
// new mode forces a decision here (TS Record completeness).
//   mirror    -> importing
//   importing -> dual_run, mirror   (abort back to mirror)
//   dual_run  -> live,     mirror   (rollback)
//   live      -> dual_run           (emergency rollback off owned writes)
export const LEGAL_ORG_TRANSITIONS: Record<OrgMode, readonly OrgMode[]> = {
  mirror: ["importing"],
  importing: ["dual_run", "mirror"],
  dual_run: ["live", "mirror"],
  live: ["dual_run"],
};

export function isOrgMode(value: string): value is OrgMode {
  return (ORG_MODES as readonly string[]).includes(value);
}

/** True iff `from -> to` is a legal transition. Identity moves are NOT legal. */
export function isLegalOrgTransition(from: OrgMode, to: OrgMode): boolean {
  return LEGAL_ORG_TRANSITIONS[from].includes(to);
}

/**
 * Throw a visible error (rule 12) unless `from -> to` is legal, after validating both
 * modes are in the known vocabulary. Guards every transition so an illegal move fails
 * loudly rather than silently no-ops.
 */
export function assertLegalOrgTransition(from: string, to: string): asserts to is OrgMode {
  if (!isOrgMode(from)) throw new Error(`unknown current org_mode: ${from}`);
  if (!isOrgMode(to)) throw new Error(`unknown target org_mode: ${to}`);
  if (!isLegalOrgTransition(from, to)) {
    const allowed = LEGAL_ORG_TRANSITIONS[from];
    const allowedText = allowed.length ? allowed.join(", ") : "(none; terminal state)";
    // Typed: an illegal move is a merchant-correctable block (409), not a system fault.
    throw new CutoverBlockedError(
      `illegal org_mode transition ${from} -> ${to}; allowed from ${from}: ${allowedText}`,
    );
  }
}

/**
 * Router predicate: only `live` routes the store-mutating autopilot writers to Calderyn's
 * own tables as the AUTHORITATIVE target. mirror/importing/dual_run keep Shopify as the
 * authoritative write target.
 */
export function writesToOwned(mode: OrgMode): boolean {
  return mode === "live";
}

/**
 * Dual-write predicate: at `dual_run` the store writers apply their Shopify write
 * (authoritative, unchanged) and then MIRROR it into the owned tables best-effort, so
 * the owned store tracks reality during the side-by-side run and the go-live parity
 * gate is checking a live system, not a stale import. A mirror failure never fails the
 * merchant's action — it is recorded visibly on the audit row instead (rule 12).
 */
export function dualWrites(mode: OrgMode): boolean {
  return mode === "dual_run";
}

/**
 * True iff the shop has a connected Shopify store (a non-null shop_domain).
 *
 * Platform model: a NATIVE shop (first-party signup that never connected Shopify) has no
 * shop_domain. Shopify is import-only for it — there is nothing to write BACK to — so it is
 * ALWAYS owned-authoritative for store mutations, regardless of org_mode. The org_mode
 * state machine (mirror/importing/dual_run keeping Shopify authoritative) only makes sense
 * for a shop being migrated OFF a real Shopify store; a native shop has nothing to mirror.
 * Store-action executors combine this with getOrgMode: `owned = !hasShopify ||
 * writesToOwned(orgMode)`, `dual = hasShopify && dualWrites(orgMode)`.
 *
 * Throws if the shop is absent (never guess at the routing target).
 */
export async function shopHasShopifyConnection(shopId: string): Promise<boolean> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();
  const { data, error } = await sb.from("shops").select("shop_domain").eq("id", shopId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`shop ${shopId} not found`);
  return (data as Record<string, unknown>).shop_domain != null;
}

/** Read a shop's current mode. Defaults to `mirror` when the column is null; throws if the
 *  shop is absent or holds an unknown mode (never guess at the routing target). */
export async function getOrgMode(shopId: string): Promise<OrgMode> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();
  const { data, error } = await sb.from("shops").select("org_mode").eq("id", shopId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`shop ${shopId} not found`);
  const raw = (data as Record<string, unknown>).org_mode;
  const mode = raw == null ? "mirror" : String(raw);
  if (!isOrgMode(mode)) throw new Error(`unknown org_mode ${mode} for shop ${shopId}`);
  return mode;
}

/**
 * Move a shop to `to`, enforcing the legal-transition machine and writing exactly one
 * append-only cutover_transition row. Fails visibly (rule 12): throws if the shop is
 * absent (never creates one), throws on an illegal transition WITHOUT writing anything,
 * and throws if the compare-and-set updates 0 rows (the shop changed under us — never a
 * silent no-op). The audit row is inserted BEFORE the shops UPDATE so a successful
 * transition can never lack its audit row. Exact discipline of transitionOrder.
 */
export async function transitionOrgMode(
  shopId: string,
  to: OrgMode,
  reason?: string,
): Promise<CutoverTransition> {
  if (!shopId) throw new Error("shopId is required");

  const sb = getSupabase();
  const current = await sb.from("shops").select("org_mode").eq("id", shopId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) throw new Error(`shop ${shopId} not found`);

  const rawFrom = (current.data as Record<string, unknown>).org_mode;
  const from = rawFrom == null ? "mirror" : String(rawFrom);
  // Throws on an illegal/unknown transition before any write (rule 12).
  assertLegalOrgTransition(from, to);

  // The hard go-live gates (Step 9 slice 3): EVERY move to `live` must pass parity
  // (mirror fully bridged into the owned SoT) AND payment-cleared (a test transaction
  // reached `paid` with a captured charge). Enforced here, the single choke point, so
  // no surface can flip a shop live past a failing gate. Throws before any write.
  // The passing evaluation records a durable migration_run row; we stamp its cutover_at
  // once the ->live compare-and-set below actually commits.
  let goLiveRunId: string | null = null;
  if (to === "live") ({ runId: goLiveRunId } = await assertGoLiveGates(shopId));

  const inserted = await sb
    .from("cutover_transition")
    .insert({ shop_id: shopId, from_mode: from, to_mode: to, reason: reason ?? null })
    .select("id, shop_id, from_mode, to_mode, reason, occurred_at")
    .single();
  if (inserted.error) throw inserted.error;
  if (!inserted.data) throw new Error("cutover_transition insert returned no row");

  // Compare-and-set on the from-mode: the UPDATE applies ONLY if the shop is still in
  // `from`. A 0-row result means a concurrent transition moved it under us — throw rather
  // than report a success on a no-op (rule 12).
  const updated = await sb
    .from("shops")
    .update({ org_mode: to })
    .eq("id", shopId)
    .eq("org_mode", from)
    .select("id");
  if (updated.error) throw updated.error;
  const affected = (updated.data as unknown[] | null)?.length ?? 0;
  if (affected !== 1) {
    // Typed: a concurrent transition is a retryable conflict (409), not a system fault.
    throw new CutoverBlockedError(
      `transitionOrgMode updated ${affected} rows for shop ${shopId}; expected exactly 1 — the shop changed under us`,
    );
  }

  // The ->live move committed: stamp cutover_at on the migration_run that gated it, so a
  // live cutover is distinguishable from a merely-passed gate. Best-effort — the cutover
  // already committed, so a stamp failure is surfaced (rule 12), never rolled back onto it.
  if (goLiveRunId) {
    try {
      await stampMigrationRunCutover(shopId, goLiveRunId);
    } catch (err) {
      console.error(`[cutover] failed to stamp cutover_at on migration_run ${goLiveRunId}`, err);
    }
  }

  // The ->live move committed: unwind any go-live test-transaction probe. Best-effort —
  // the cutover already committed, so a cleanup failure is surfaced, never rolled back.
  if (to === "live") {
    try {
      await refundTestOrders(shopId, sb);
    } catch (err) {
      console.error(`[cutover] test-order cleanup failed after go-live for shop ${shopId}`, err);
    }
  }

  return mapTransition(inserted.data as Record<string, unknown>);
}

function mapTransition(row: Record<string, unknown>): CutoverTransition {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    fromMode: String(row.from_mode) as OrgMode,
    toMode: String(row.to_mode) as OrgMode,
    reason: row.reason == null ? null : String(row.reason),
    occurredAt: String(row.occurred_at),
  };
}
