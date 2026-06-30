// Deterministic per-client commerce guard (rule 5: spend authority is code, not model
// judgement). Checked BEFORE any charge. Commerce is ON by default for a REGISTERED client
// (frictionless); a merchant may explicitly disable a client (commerce_scope=false) or set a
// per-order cap (spend_cap_cents > 0). spend_cap_cents = 0 means UNLIMITED — no ceiling enforced.
// "Frictionless" applies only to clients that exist in the OAuth registry: a missing principal
// (no clientId) or an UNREGISTERED client (no row) is never authorized — frictionless lowers
// merchant setup, it does not authorize anonymous/unknown callers.
import { getSupabase } from "~/lib/supabase.server";

export class CommerceDisabledError extends Error {
  code = "COMMERCE_DISABLED";
  constructor(clientId: string) { super(`client ${clientId} is not authorized for commerce`); }
}
export class SpendCapError extends Error {
  code = "SPEND_CAP_EXCEEDED";
  constructor(clientId: string, amount: number, cap: number) {
    super(`client ${clientId} order ${amount}c exceeds spend cap ${cap}c`);
  }
}

export async function assertWithinCommerceCap(clientId: string, amountCents: number): Promise<void> {
  // A missing principal is never an authorized, capped client (frictionless ≠ anonymous).
  if (!clientId) throw new CommerceDisabledError("(none)");
  const res = await getSupabase()
    .from("mcp_oauth_clients")
    .select("commerce_scope, spend_cap_cents")
    .eq("client_id", clientId)
    .maybeSingle();
  if (res.error) throw res.error;
  const row = res.data as { commerce_scope?: boolean; spend_cap_cents?: number } | null;
  // Deny an UNREGISTERED client (no row) or one the merchant explicitly disabled
  // (commerce_scope=false). A registered client defaults to commerce_scope=true → frictionless.
  if (!row || row.commerce_scope === false) throw new CommerceDisabledError(clientId);
  // Cap of 0 or absent = UNLIMITED. Only enforce when a positive cap is set.
  const cap = Number(row?.spend_cap_cents ?? 0);
  if (cap > 0 && amountCents > cap) throw new SpendCapError(clientId, amountCents, cap);
}
