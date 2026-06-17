import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { acquireTrainLock, releaseTrainLock } from "~/lib/moat/train-lock.server";

// Nightly wrapper that drives the slice-#3 moat trainer (Python engine). Mirrors
// cron.detect: CRON_SECRET bearer auth, then reach the engine over HTTP at the
// PUBLIC app origin (Vercel deployment protection walls off the self-fetch on the
// *.vercel.app URL). The trainer is a Python serverless function and MUST stay on
// its own /api/engine/* path — a Remix route sharing that URL collides at the
// build-output function dir and 501s every route (2026-06-16 outage, commit 551dabf).
//
// Trainer entrypoint (resolved contract): POST /api/engine/moat-train, body {},
// success 200 { etl, shops_trained, models_written, skipped, errors[] }. A 503
// is returned when MOAT_PEPPER is unset. Non-empty errors[] is a partial run and
// is fail-visible (non-200) even on HTTP 200. If the entrypoint ever moves, only
// ENGINE_PATH and the response keys below change.
const ENGINE_PATH = "/api/engine/moat-train";

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

  const sb = getSupabase();
  const origin = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const startedAt = Date.now();

  // Single-flight: a slow run + the next tick (or a Vercel retry) must not start a
  // second trainer pass. A skipped-because-locked tick is a SUCCESS for the
  // scheduler (it correctly declined to double-train), so it is 200, not an error.
  const acquired = await acquireTrainLock(sb);
  if (!acquired) {
    console.warn("[cron.moat-train] skipped: already running");
    return json({ ok: true, skipped: "locked" as const });
  }

  console.log(`[cron.moat-train] start origin=${origin}`);
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
      // Transport-level failure (incl. 503 MOAT_PEPPER unconfigured): surface it
      // (rule 12), do not report success.
      console.error(`[cron.moat-train] trainer HTTP ${res.status}`);
      return json({ ok: false, error: `trainer HTTP ${res.status}` }, { status: 502 });
    }

    const result = (await res.json()) as TrainerResult;
    const durationMs = Date.now() - startedAt;
    const errors = result.errors ?? [];

    console.log(
      `[cron.moat-train] done shops_trained=${result.shops_trained} ` +
        `models_written=${result.models_written} skipped=${result.skipped ?? 0} ` +
        `errors=${errors.length} duration_ms=${durationMs}`,
    );

    if (errors.length > 0) {
      // Partial cohort train is a VISIBLE failure even though some shops succeeded:
      // never 200 here (rule 12). Echo errors[] in both the body and the logs.
      console.error(`[cron.moat-train] partial run: ${errors.join("; ")}`);
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
    console.error("[cron.moat-train] trainer invocation failed", err);
    return json({ ok: false, error: message }, { status: 502 });
  } finally {
    // Always release so a crashed run cannot wedge the lock for the next night.
    await releaseTrainLock(sb);
  }
};
