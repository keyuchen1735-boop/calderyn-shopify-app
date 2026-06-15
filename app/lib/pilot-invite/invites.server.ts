// app/lib/pilot-invite/invites.server.ts
// Append-only send log in Supabase (public.pilot_invites). Never throws (rule 12).
import { getSupabase } from "~/lib/supabase.server";

export interface InviteLogRow {
  email: string;
  firstName: string;
  storeName: string;
  status: "sent" | "failed";
  resendId?: string | null;
  error?: string | null;
}

export async function logInvite(row: InviteLogRow): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await getSupabase().from("pilot_invites").insert({
      email: row.email.toLowerCase(),
      first_name: row.firstName,
      store_name: row.storeName,
      status: row.status,
      resend_id: row.resendId ?? null,
      error: row.error ?? null,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function hasSuccessfulInvite(email: string): Promise<{ invited: boolean; error?: string }> {
  try {
    const { data, error } = await getSupabase()
      .from("pilot_invites").select("id").eq("email", email.toLowerCase()).eq("status", "sent").limit(1);
    return error ? { invited: false, error: error.message } : { invited: (data?.length ?? 0) > 0 };
  } catch (e) {
    return { invited: false, error: e instanceof Error ? e.message : String(e) };
  }
}
