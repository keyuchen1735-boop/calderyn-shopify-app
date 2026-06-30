// Deterministic per-client commerce guard (rule 5: spend authority is code, not model
// judgement). Checked BEFORE any charge. A client must carry commerce_scope and the order
// total must be <= its spend_cap_cents, else the transaction is refused, visibly.
import { getSupabase } from "~/lib/supabase.server";

export class CommerceNotAuthorizedError extends Error {
  code = "COMMERCE_NOT_AUTHORIZED";
  constructor(clientId: string) { super(`client ${clientId} is not authorized for commerce`); }
}
export class SpendCapError extends Error {
  code = "SPEND_CAP_EXCEEDED";
  constructor(clientId: string, amount: number, cap: number) {
    super(`client ${clientId} order ${amount}c exceeds spend cap ${cap}c`);
  }
}

export async function assertWithinCommerceCap(clientId: string, amountCents: number): Promise<void> {
  if (!clientId) throw new CommerceNotAuthorizedError("(none)");
  const res = await getSupabase()
    .from("mcp_oauth_clients")
    .select("commerce_scope, spend_cap_cents")
    .eq("client_id", clientId)
    .maybeSingle();
  if (res.error) throw res.error;
  const row = res.data as { commerce_scope?: boolean; spend_cap_cents?: number } | null;
  if (!row?.commerce_scope) throw new CommerceNotAuthorizedError(clientId);
  const cap = Number(row.spend_cap_cents ?? 0);
  if (amountCents > cap) throw new SpendCapError(clientId, amountCents, cap);
}
