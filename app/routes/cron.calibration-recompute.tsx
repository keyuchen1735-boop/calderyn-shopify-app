// Nightly: recompute every shop's calibration headline. Thin by design - the
// math lives in lib/calibration. Deviation from the autopilot-train pattern
// (which POSTs to a Python engine fn) is intentional: the confidence formula
// must have ONE implementation (TS), so we do not round-trip to Python.

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { recomputeShopCalibration } from "~/lib/calibration/recompute.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const startedAt = Date.now();
  const errors: string[] = [];
  let count = 0;

  const { data: shops, error } = await sb.from("shops").select("id");
  if (error) return json({ ok: false, error: error.message }, { status: 502 });

  for (const s of shops ?? []) {
    try {
      await recomputeShopCalibration(s.id as string, { sb });
      count += 1;
    } catch (err) {
      errors.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const duration_ms = Date.now() - startedAt;
  if (errors.length > 0) {
    console.error(`[cron.calibration-recompute] partial: ${errors.join("; ")}`);
    return json({ ok: false, shops: count, errors, duration_ms }, { status: 500 });
  }
  return json({ ok: true, shops: count, errors, duration_ms });
};
