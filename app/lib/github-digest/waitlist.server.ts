// app/lib/github-digest/waitlist.server.ts
//
// Collects new Calderyn waitlist signups for the daily dev digest. The public
// marketing site (Mezoh/calderyn-waitlist) writes signups into the SAME Supabase
// project this app uses (public.waitlist), so the digest reads them directly —
// no cross-repo plumbing. Like the GitHub collector, a failure here degrades to
// an empty list plus a surfaced note; it never throws and sinks the digest (rule 12).
//
// PII note: `email` and `phone` are personal data. They are shown only in the
// internal founder digest email and are NEVER sent to the AI model.

import { getSupabase } from "~/lib/supabase.server";

export interface WaitlistSignup {
  email: string;
  /** E.164-ish phone, when the member provided one. */
  phone: string | null;
  /** The member's own shareable referral code. */
  referralCode: string;
  /** Referral code of whoever referred them, when present. */
  referredBy: string | null;
  createdAtIso: string;
}

export interface WaitlistResult {
  signups: WaitlistSignup[];
  /** Non-fatal failure surfaced to the digest summary (never swallowed). */
  note: string | null;
}

// A daily window will never approach this; the cap just bounds a pathological
// backfill so the email stays sane.
const MAX_SIGNUPS = 500;

interface WaitlistRow {
  email?: string | null;
  phone?: string | null;
  referral_code?: string | null;
  referred_by?: string | null;
  created_at?: string | null;
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * New waitlist signups created at/after `sinceMs`, newest first. Any failure
 * (Supabase unconfigured, query error) degrades to an empty list plus a surfaced
 * note — it never throws, so a waitlist hiccup can't sink the GitHub digest.
 */
export async function collectWaitlistSignups(opts: { sinceMs: number }): Promise<WaitlistResult> {
  try {
    const sinceIso = new Date(opts.sinceMs).toISOString();
    const res = await getSupabase()
      .from("waitlist")
      .select("email, phone, referral_code, referred_by, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(MAX_SIGNUPS);

    if (res.error) {
      return { signups: [], note: `Waitlist signups unavailable: ${errMessage(res.error)}` };
    }

    const rows = (res.data ?? []) as unknown as WaitlistRow[];
    const signups: WaitlistSignup[] = rows
      .filter((r): r is WaitlistRow & { email: string } => typeof r.email === "string" && r.email.length > 0)
      .map((r) => ({
        email: r.email,
        phone: r.phone ?? null,
        referralCode: r.referral_code ?? "",
        referredBy: r.referred_by ?? null,
        createdAtIso: r.created_at ?? "",
      }));
    return { signups, note: null };
  } catch (err) {
    return { signups: [], note: `Waitlist signups unavailable: ${errMessage(err)}` };
  }
}
