import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Nightly wrapper that drives the autopilot trainer (Python engine). Mirrors
// cron.moat-train: CRON_SECRET bearer auth, then reach the engine over HTTP at
// the PUBLIC app origin. The trainer is a Python serverless function and MUST
// stay on its own /api/engine/* path — a Remix route sharing that URL collides
// at the build-output function dir and 501s every route.
//
// Trainer entrypoint (resolved contract): POST /api/engine/autopilot-train,
// body {}, success 200 { etl, shops_trained, models_written, skipped, errors[] }.
// Non-empty errors[] is a partial run and is fail-visible (non-200) even on HTTP
// 200. No single-flight lock needed here: the moat.action_models PK upsert is
// concurrency-safe (spec §9), so double-runs are idempotent.
const ENGINE_PATH = "/api/engine/autopilot-train";

type TrainerResult = {
  etl?: Record<string, number>;
  shops_trained: number;
  models_written: number;
  skipped?: number;
  errors: string[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // getSupabase is called for symmetry with sibling cron routes (session/context
  // may be needed by future middleware layers), even though this route does not
  // query Supabase directly.
  getSupabase();
  const origin = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const startedAt = Date.now();

  console.log(`[cron.autopilot-train] start origin=${origin}`);
  try {
    const res = await fetch(`${origin}${ENGINE_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CRON_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      // Transport-level failure: surface it (rule 12), do not report success.
      console.error(`[cron.autopilot-train] trainer HTTP ${res.status}`);
      return json({ ok: false, error: `trainer HTTP ${res.status}` }, { status: 502 });
    }

    const result = (await res.json()) as TrainerResult;
    const durationMs = Date.now() - startedAt;
    const errors = result.errors ?? [];

    console.log(
      `[cron.autopilot-train] done shops_trained=${result.shops_trained} ` +
        `models_written=${result.models_written} skipped=${result.skipped ?? 0} ` +
        `errors=${errors.length} duration_ms=${durationMs}`,
    );

    if (errors.length > 0) {
      // Partial cohort train is a VISIBLE failure even though some shops succeeded:
      // never 200 here (rule 12). Echo errors[] in both the body and the logs.
      console.error(`[cron.autopilot-train] partial run: ${errors.join("; ")}`);
      return json(
        {
          ok: false,
          etl: result.etl,
          shops_trained: result.shops_trained,
          models_written: result.models_written,
          skipped: result.skipped,
          errors,
          duration_ms: durationMs,
        },
        { status: 500 },
      );
    }

    return json({
      ok: true,
      etl: result.etl,
      shops_trained: result.shops_trained,
      models_written: result.models_written,
      skipped: result.skipped,
      errors,
      duration_ms: durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron.autopilot-train] trainer invocation failed", err);
    return json({ ok: false, error: message }, { status: 502 });
  }
};
