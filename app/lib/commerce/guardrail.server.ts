// Deterministic per-client commerce guard (rule 5: spend authority is code, not model
// judgement). Checked BEFORE any charge. Commerce is ON by default (frictionless); a merchant
// may explicitly disable a client (commerce_scope=false) or set a per-order cap
// (spend_cap_cents > 0). spend_cap_cents = 0 means UNLIMITED — no ceiling enforced.
import { getSupabase } from "~/lib/supabase.server";

export class CommerceDisabledError extends Error {
  code = "COMMERCE_DISABLED";
  constructor(clientId: string) { super(`client ${clientId} has commerce disabled by the merchant`); }
}
export class SpendCapError extends Error {
  code = "SPEND_CAP_EXCEEDED";
  constructor(clientId: string, amount: number, cap: number) {
    super(`client ${clientId} order ${amount}c exceeds spend cap ${cap}c`);
  }
}

export async function assertWithinCommerceCap(clientId: string, amountCents: number): Promise<void> {
  const res = await getSupabase()
    .from("mcp_oauth_clients")
    .select("commerce_scope, spend_cap_cents")
    .eq("client_id", clientId)
    .maybeSingle();
  if (res.error) throw res.error;
  const row = res.data as { commerce_scope?: boolean; spend_cap_cents?: number } | null;
  // No row = frictionless (client is in by default). Row with commerce_scope=false = merchant override.
  if (row !== null && row.commerce_scope === false) throw new CommerceDisabledError(clientId);
  // Cap of 0 or absent = UNLIMITED. Only enforce when a positive cap is set.
  const cap = Number(row?.spend_cap_cents ?? 0);
  if (cap > 0 && amountCents > cap) throw new SpendCapError(clientId, amountCents, cap);
}
