// Order-note authoring (Task 10): resolves who a staff note gets attributed to.
import type { SupabaseClient } from "@supabase/supabase-js";

export const MIN_NOTE_LENGTH = 1;
export const MAX_NOTE_LENGTH = 2000;

/** True when a note body is within the accepted 1-2000 char bound. */
export function isValidNoteBody(body: unknown): body is string {
  return typeof body === "string" && body.length >= MIN_NOTE_LENGTH && body.length <= MAX_NOTE_LENGTH;
}

/**
 * DashboardSession carries no email (it's a shop-scoped session, not a person — see
 * session.server.ts's module header); a first-party session does carry `userId`, so resolve the
 * merchant's real address through it when present. A Shopify-based session (userId null) and a
 * lookup miss both fall back to the literal "merchant" author, same as every other executor's
 * `actor_user_id: input.actor ?? "merchant"` convention.
 */
export async function resolveAuthorEmail(sb: SupabaseClient, userId: string | null): Promise<string> {
  if (!userId) return "merchant";
  const { data, error } = await sb.from("users").select("email").eq("id", userId).maybeSingle();
  if (error) throw error;
  const email = (data as Record<string, unknown> | null)?.email;
  return typeof email === "string" && email ? email : "merchant";
}
