// Server-side store for Tier-2 (confirm-gated) assistant actions. The chat
// client only ever holds the pending id; parameters, summary and expiry live
// here, so a tampered confirm request cannot alter what executes.
import { getSupabase } from "../../supabase.server";
import type { PendingActionCard } from "./registry-types";

const PENDING_TTL_MS = 10 * 60_000;

export async function createPendingAction(
  shopId: string,
  conversationId: string,
  action: string,
  input: Record<string, unknown>,
  summary: string,
): Promise<PendingActionCard> {
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
  const { data, error } = await getSupabase()
    .from("assistant_pending_actions")
    .insert({ shop_id: shopId, conversation_id: conversationId, action, input, summary, expires_at: expiresAt })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id), action, summary, expiresAt };
}

export type ClaimResult =
  | { action: string; input: Record<string, unknown>; conversationId: string }
  | { error: "not_found" | "expired" | "already_used" };

/**
 * Atomically claim a pending action for execution. The conditional UPDATE
 * (status='pending' filter) is the single-use guard: a second confirm — even a
 * concurrent one — matches 0 rows. A claim that later fails to execute stays
 * consumed on purpose; the merchant re-asks and the model re-proposes.
 */
export async function claimPendingAction(shopId: string, pendingId: string): Promise<ClaimResult> {
  const sb = getSupabase();
  const { data: claimed, error } = await sb
    .from("assistant_pending_actions")
    .update({ status: "executed" })
    .eq("shop_id", shopId)
    .eq("id", pendingId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("action, input, conversation_id")
    .maybeSingle();
  if (error) throw error;
  if (claimed) {
    return {
      action: String(claimed.action),
      input: (claimed.input as Record<string, unknown>) ?? {},
      conversationId: String(claimed.conversation_id),
    };
  }
  // Distinguish why the claim missed, for an honest error message.
  const { data: row, error: rErr } = await sb
    .from("assistant_pending_actions")
    .select("status, expires_at")
    .eq("shop_id", shopId)
    .eq("id", pendingId)
    .maybeSingle();
  if (rErr) throw rErr;
  if (!row) return { error: "not_found" };
  if (row.status !== "pending") return { error: "already_used" };
  return { error: "expired" };
}

export async function dismissPendingAction(shopId: string, pendingId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("assistant_pending_actions")
    .update({ status: "dismissed" })
    .eq("shop_id", shopId)
    .eq("id", pendingId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function markPendingExecuted(
  shopId: string,
  pendingId: string,
  auditId: string | null,
): Promise<void> {
  const { error } = await getSupabase()
    .from("assistant_pending_actions")
    .update({ executed_audit_id: auditId })
    .eq("shop_id", shopId)
    .eq("id", pendingId);
  if (error) throw error;
}
