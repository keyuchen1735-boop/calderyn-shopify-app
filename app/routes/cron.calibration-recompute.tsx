// Hourly (at :45, between the autopilot ticks at :00/:30): recompute every
// shop's calibration headline. Thin by design - the math lives in
// lib/calibration. Deviation from the autopilot-train pattern (which POSTs to
// a Python engine fn) is intentional: the confidence formula must have ONE
// implementation (TS), so we do not round-trip to Python.
//
// Hourly cadence safety: the pair cache is a pure re-derivation (idempotent),
// and the headline honors I6's ±5-per-DAY bound via the day anchor inside
// recomputeShopCalibration (smooth()'s per-run clamp alone would not).
//
// The ORGANIC sweep stays a nightly batch (the ORGANIC_SWEEP_UTC_HOUR run
// only). Its MASS_PAUSE_LIMIT bulk-pause suppression is a per-sweep batch
// heuristic: a merchant's seasonal shutdown paused over an afternoon must be
// seen in ONE sweep (> limit → credit nothing), which hourly slices of 2-3
// campaigns would misread as per-suggestion agreement and credit. The
// individual credits are still exactly-once (open→acknowledged transition and
// the action_feedback reversal ledger are the dedup) — the batching is about
// classification, not double-counting. It runs BEFORE that run's recompute so
// the nightly headline reflects what the merchant did on the platform
// themselves (implicit approvals of open pause suggestions, out-of-band
// reversals of autonomous pauses). Demo shops are skipped: their seeded
// synthetic state simulates action side effects and would misfire the organic
// matchers.
//
// Scale shape (the ingest cron's 504 lesson): peer priors are fetched ONCE
// for the whole run (they are shop-independent) and shared across shops;
// shops run through a small bounded-concurrency pool instead of a serial
// loop; and the route declares its own maxDuration. Safe to export config
// here: cron routes are loader-only resource routes with no single-fetch
// `.data` client path (unlike page routes — see the note in
// app.campaigns.$campaignId.score.tsx).

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { loadPeerPriors, recomputeShopCalibration } from "~/lib/calibration/recompute.server";
import { sweepOrganicSignals } from "~/lib/calibration/organic.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

export const config = { maxDuration: 300 };

/** How many shops are processed concurrently. Each shop is a handful of
 * batched round trips; 4 keeps the DB comfortable while cutting wall-clock
 * roughly 4x vs the old serial loop. */
const SHOP_CONCURRENCY = 4;

/** The one hourly run that also performs the nightly organic-signal sweep
 * (06:45 UTC — the slot the old nightly cron occupied). See header comment. */
export const ORGANIC_SWEEP_UTC_HOUR = 6;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const startedAt = Date.now();
  const errors: string[] = [];
  // Organic-sweep failures are best-effort by contract (sweepOrganicSignals never
  // throws; per-signal read hiccups are collected here). They must NOT flip the
  // run's exit status: a single transient organic read on one shop would otherwise
  // 500 the whole cron even though every shop's recompute succeeded, tripping
  // Vercel's failed-cron alerting + a full-run retry. Surfaced, never fatal.
  const organicErrors: string[] = [];
  let count = 0;
  let implicitApprovals = 0;
  let reversals = 0;

  const { data: shops, error } = await sb.from("shops").select("id, demo_mode");
  if (error) return json({ ok: false, error: error.message }, { status: 502 });

  const runOrganicSweep = new Date().getUTCHours() === ORGANIC_SWEEP_UTC_HOUR;

  // Peer baselines are shop-independent: one bulk fetch serves the whole run.
  const peerPriors = await loadPeerPriors(sb);

  const queue = [...(shops ?? [])];
  const worker = async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      const shopId = s.id as string;
      // Organic sweep first (never throws; per-signal failures are collected)
      // so the recompute below scores tonight's conf WITH the new signals.
      // Nightly-batch only: see ORGANIC_SWEEP_UTC_HOUR.
      if (runOrganicSweep && !s.demo_mode) {
        const organic = await sweepOrganicSignals(shopId, sb);
        implicitApprovals += organic.implicitApprovals;
        reversals += organic.reversals;
        for (const e of organic.errors) organicErrors.push(`${shopId} organic: ${e}`);
      }
      try {
        await recomputeShopCalibration(shopId, { sb }, { peerPriors });
        count += 1;
      } catch (err) {
        errors.push(`${shopId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SHOP_CONCURRENCY, queue.length) }, () => worker()),
  );

  const duration_ms = Date.now() - startedAt;
  if (organicErrors.length > 0) {
    console.warn(`[cron.calibration-recompute] organic soft-errors: ${organicErrors.join("; ")}`);
  }
  if (errors.length > 0) {
    console.error(`[cron.calibration-recompute] partial: ${errors.join("; ")}`);
    return json(
      { ok: false, shops: count, implicitApprovals, reversals, errors, organicErrors, duration_ms },
      { status: 500 },
    );
  }
  return json({ ok: true, shops: count, implicitApprovals, reversals, errors, organicErrors, duration_ms });
};
