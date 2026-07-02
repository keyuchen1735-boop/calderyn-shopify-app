// Nightly: recompute every shop's calibration headline. Thin by design - the
// math lives in lib/calibration. Deviation from the autopilot-train pattern
// (which POSTs to a Python engine fn) is intentional: the confidence formula
// must have ONE implementation (TS), so we do not round-trip to Python.
//
// The organic-signal sweep runs per shop BEFORE the recompute so tonight's
// headline already reflects what the merchant did on the platform themselves
// (implicit approvals of open pause suggestions, out-of-band reversals of
// autonomous pauses). Demo shops are skipped: their seeded synthetic state
// simulates action side effects and would misfire the organic matchers.

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { recomputeShopCalibration } from "~/lib/calibration/recompute.server";
import { sweepOrganicSignals } from "~/lib/calibration/organic.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const startedAt = Date.now();
  const errors: string[] = [];
  let count = 0;
  let implicitApprovals = 0;
  let reversals = 0;

  const { data: shops, error } = await sb.from("shops").select("id, demo_mode");
  if (error) return json({ ok: false, error: error.message }, { status: 502 });

  for (const s of shops ?? []) {
    const shopId = s.id as string;
    // Organic sweep first (never throws; per-signal failures are collected) so
    // the recompute below scores tonight's conf WITH the new signals folded in.
    if (!s.demo_mode) {
      const organic = await sweepOrganicSignals(shopId, sb);
      implicitApprovals += organic.implicitApprovals;
      reversals += organic.reversals;
      for (const e of organic.errors) errors.push(`${shopId} organic: ${e}`);
    }
    try {
      await recomputeShopCalibration(shopId, { sb });
      count += 1;
    } catch (err) {
      errors.push(`${shopId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const duration_ms = Date.now() - startedAt;
  if (errors.length > 0) {
    console.error(`[cron.calibration-recompute] partial: ${errors.join("; ")}`);
    return json(
      { ok: false, shops: count, implicitApprovals, reversals, errors, duration_ms },
      { status: 500 },
    );
  }
  return json({ ok: true, shops: count, implicitApprovals, reversals, errors, duration_ms });
};
