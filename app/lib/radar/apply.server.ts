// Orchestrator behind the dashboard.api.radar actions: load + guard the move,
// dispatch to the kind-specific executor, persist the outcome. Executor
// failures propagate untouched - the move stays draft and the route surfaces
// the real error on the card (spec: no partial publishes, no swallowing).
import {
  applyOrgRefresh,
  applySeoMeta,
  RadarApplyError,
  revertOrgRefresh,
  revertSeoMeta,
  type ApplyOutcome,
} from "./apply-seo.server";
import { applySectionRefresh, revertSectionRefresh } from "./apply-section.server";
import { getMove, updateMove } from "./store.server";
import type { RadarMoveRow } from "./types";

async function loadOpenMove(shopId: string, moveId: string, wantStatus: "draft" | "applied"): Promise<RadarMoveRow> {
  const move = await getMove(shopId, moveId);
  if (!move) throw new RadarApplyError("move_not_found", "That move no longer exists.", 404);
  if (wantStatus === "draft" && move.status !== "draft") {
    throw new RadarApplyError("move_not_open", "This move was already handled.", 409);
  }
  if (wantStatus === "applied" && move.status !== "applied") {
    throw new RadarApplyError("move_not_applied", "Only an applied move can be reverted.", 409);
  }
  return move;
}

export async function applyMove(input: {
  shopId: string;
  moveId: string;
  actorId: string | null;
}): Promise<RadarMoveRow> {
  const move = await loadOpenMove(input.shopId, input.moveId, "draft");
  const mode = String(move.payload.applyMode ?? "review");
  let outcome: ApplyOutcome;
  if (mode === "publish_meta") outcome = await applySeoMeta(input.shopId, move, input.actorId);
  else if (mode === "refresh_org") outcome = await applyOrgRefresh(input.shopId, move);
  else if (mode === "refresh_section") outcome = await applySectionRefresh(input.shopId, move, input.actorId);
  else outcome = { priorState: null, appliedStateHash: null }; // review: applying = reviewed
  const appliedAt = new Date().toISOString();
  await updateMove(input.shopId, move.id, {
    status: "applied",
    appliedAt,
    priorState: outcome.priorState,
    appliedStateHash: outcome.appliedStateHash,
  });
  return { ...move, status: "applied", appliedAt, priorState: outcome.priorState, appliedStateHash: outcome.appliedStateHash };
}

export async function dismissMove(input: { shopId: string; moveId: string }): Promise<RadarMoveRow> {
  const move = await loadOpenMove(input.shopId, input.moveId, "draft");
  const resolvedAt = new Date().toISOString();
  await updateMove(input.shopId, move.id, { status: "dismissed", resolvedAt });
  return { ...move, status: "dismissed", resolvedAt };
}

export async function revertMove(input: {
  shopId: string;
  moveId: string;
  actorId: string | null;
  confirm: boolean;
}): Promise<RadarMoveRow> {
  const move = await loadOpenMove(input.shopId, input.moveId, "applied");
  const kind = String((move.priorState as { kind?: unknown } | null)?.kind ?? "");
  if (!kind) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  if (kind === "seo_meta") await revertSeoMeta(input.shopId, move, { confirm: input.confirm }, input.actorId);
  else if (kind === "org") await revertOrgRefresh(input.shopId, move, { confirm: input.confirm });
  else if (kind === "section") await revertSectionRefresh(input.shopId, move, { confirm: input.confirm }, input.actorId);
  else throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  const resolvedAt = new Date().toISOString();
  const payload = { ...move.payload, reverted: true };
  await updateMove(input.shopId, move.id, { status: "dismissed", resolvedAt, payload });
  return { ...move, status: "dismissed", resolvedAt, payload };
}
