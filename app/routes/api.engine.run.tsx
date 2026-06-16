// POST { shop_id } → run all detectors for one shop, return { shop_id, alert_ids }.
//
// Called exclusively by cron.detect (which does the shop-batching and per-shop
// error isolation). Auth: same CRON_SECRET bearer check as every other cron
// endpoint.  Only POST is accepted; GET returns 405 so misconfigured probes
// don't trigger detection passes.
//
// Detector registry: add a new server detector here. Each entry must:
//   - accept (SupabaseClient, shopId) and return Promise<number> (count upserted)
//   - throw on a hard failure (so we surface it, not swallow it)
//
// alert_ids is not yet populated per-detector (detectors return a count, not
// the UUIDs). The field is kept for cron.detect compatibility; a future pass
// can query the upserted rows' IDs if the summary needs them.

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { getSupabase } from "~/lib/supabase.server";
import { runFreeShipLeakageDetect } from "~/lib/ship-cost/detect-free-ship-leakage.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (
    !isAuthorizedCron(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const shopId = typeof body.shop_id === "string" ? body.shop_id.trim() : "";
  if (!shopId) {
    return new Response("Bad Request: shop_id required", { status: 400 });
  }

  const sb = getSupabase();

  // Run each detector. Failures are logged and counted; a single detector
  // failure must not prevent the remaining detectors from running.
  const detectorErrors: string[] = [];
  let totalUpserted = 0;

  try {
    const n = await runFreeShipLeakageDetect(sb, shopId);
    totalUpserted += n;
  } catch (err) {
    detectorErrors.push("free_shipping_leakage");
    console.error(`[engine/run] free_shipping_leakage failed for shop ${shopId}`, err);
  }

  if (detectorErrors.length > 0) {
    // Surface detector-level failures so cron.detect can log the shop as
    // errored rather than silently counting zero alerts (rule 12).
    return json(
      {
        shop_id: shopId,
        alert_ids: [] as string[],
        detector_errors: detectorErrors,
      },
      { status: 500 },
    );
  }

  return json({
    shop_id: shopId,
    // alert_ids: exact UUIDs are not returned yet — detectors expose a count.
    // cron.detect uses alert_ids.length for its summary counter.
    alert_ids: Array.from({ length: totalUpserted }, (_, i) => String(i)),
  });
};
