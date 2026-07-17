// app/lib/rate-limit.server.ts
//
// Cross-instance fixed-window rate limiter backed by Postgres (the
// public.rate_limit_touch RPC). Replaces the previous in-memory limiter, which
// only damped abuse per serverless instance — on Vercel Fluid Compute an
// attacker spread across warm instances multiplied the effective limit.
//
// Fails OPEN: if the limiter's own DB round-trip errors (or Supabase is not
// configured, e.g. in unit tests), we log and ALLOW the request rather than
// lock people out of login. Rate limiting here is defense-in-depth, not the
// primary auth control, so its outage must not become an outage of the app.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase.server";

/**
 * Record one hit against `key` and report whether it is still within `limit`
 * for the current fixed window of `windowMs`. Returns true = allowed.
 *
 * Signature mirrors the old in-memory limiter (key, limit, windowMs) so call
 * sites only gain an `await`. `client` is injectable for tests.
 */
/** Frees a limiter bucket early (e.g. a build lock released when the build
 *  finishes or fails, instead of blocking retries for the full window).
 *  Best-effort: a failure just means the window expires naturally. */
export async function releaseRateLimit(key: string, client?: SupabaseClient): Promise<void> {
  try {
    const sb = client ?? getSupabase();
    await sb.from("rate_limit_hits").delete().eq("bucket", key);
  } catch (e) {
    console.error("[rate-limit] release failed (window will expire naturally)", {
      key,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  client?: SupabaseClient,
): Promise<boolean> {
  const windowSec = Math.max(1, Math.round(windowMs / 1000));
  try {
    const sb = client ?? getSupabase();
    const { data, error } = await sb.rpc("rate_limit_touch", {
      p_bucket: key,
      p_window_seconds: windowSec,
    });
    if (error) {
      console.error("[rate-limit] limiter unavailable, failing open", {
        key,
        error: error.message,
      });
      return true;
    }
    return Number(data) <= limit;
  } catch (e) {
    console.error("[rate-limit] limiter unavailable, failing open", {
      key,
      error: e instanceof Error ? e.message : String(e),
    });
    return true;
  }
}

/** Stable per-client key for rate limiting (Vercel sets x-forwarded-for). */
export function clientIpKey(request: Request, scope: string): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return `${scope}:${ip}`;
}
