import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { rateLimit } from "~/lib/rate-limit.server";
import { getSupabase } from "~/lib/supabase.server";
import { resetDemoShowcase, type ShowcaseResetClient } from "~/lib/demo/reset.server";

// Compensating decrement of the just-consumed rate-limit token when the reset it
// gated fails. Targets the current window row (rate_limit_touch upserts the newest
// window_start). Best-effort, never throws.
async function refundResetHit(bucket: string): Promise<void> {
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from("rate_limit_hits")
      .select("window_start, count")
      .eq("bucket", bucket)
      .order("window_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return;
    await sb
      .from("rate_limit_hits")
      .update({ count: Math.max(0, Number(data.count) - 1) })
      .eq("bucket", bucket)
      .eq("window_start", data.window_start as string);
  } catch (err) {
    console.error("[demo-reset] rate-limit refund failed", err);
  }
}

// POST: wipe the signed-in DEMO shop back to its seeded opening scene. The
// orchestrator re-checks shops.demo_mode itself (409 not_demo_shop otherwise),
// so a real shop can never reach the wipe even if the UI gate regresses. A
// reset takes a few seconds; the limiter absorbs double-clicks racing two wipes.
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const bucket = `demo-reset:${session.shopId}`;
  if (!(await rateLimit(bucket, 1, 60_000))) {
    return jsonError(429, "rate_limited", "A reset just ran. Give it a minute.");
  }
  return dashboardJson(async () => {
    // Cast justified in ShowcaseResetClient's doc: supabase-js's generics
    // exceed TS's structural-check depth; the runtime builder shape matches.
    const sb = getSupabase() as unknown as ShowcaseResetClient;
    try {
      const summary = await resetDemoShowcase(session.shopId, sb);
      return { ok: true, summary };
    } catch (err) {
      // The reset is non-transactional (wipe-first): a mid-reseed failure leaves
      // the store empty and the fix is to run it AGAIN. Don't let the 1-per-60s
      // limiter block that recovery — refund the token before surfacing the error.
      await refundResetHit(bucket);
      throw err;
    }
  });
}
