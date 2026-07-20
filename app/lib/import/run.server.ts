// Import-from-Shopify (#13.promote): the import state machine. `startImport` records a
// pending run; the /cron/import tick calls `drainImports` to do the pull + promote; the
// dashboard polls `latestImport`. Kept small — the heavy lifting is backfillShop +
// promote_shop_from_mirror.
import { getSupabase } from "../supabase.server";
import { backfillShop } from "../ingest/backfill.server";
import { syncShopifySellingPlans } from "../ingest/shopify-selling-plans.server";
import { promoteShopFromMirror, buildImportReport, type PromoteCounts } from "./promote.server";
import { importCustomers } from "./customers.server";
import { relinkOrdersToBuyers } from "./relink.server";
import { syncShopifyProductFacts } from "../ingest/product-facts.server";

const IMPORT_WINDOW_DAYS = 365; // 12 months
// A 12-month pull is heavy; bound how many imports one cron tick processes so the
// serverless function stays under its timeout (mirrors Phase 1's MAX_BACKFILL_SHOPS).
// Runs are selected by state with no claim step, so overlapping drains (the cron
// tick plus kickDrainSoon fired from connect/import at arbitrary times) routinely
// process the same run. Tolerated rather than locked: the pull + promote are
// idempotent, so a double-processed run converges to the same owned rows, and the
// state transitions below are guarded so a slow duplicate can never regress a
// terminal `done`. Revisit with a claim step if drain concurrency grows further.
const IMPORT_DRAIN_PER_TICK = 2;

// A drain killed at the function ceiling can strand a run in either in-progress
// state; selecting both lets the next drain self-heal it (idempotent re-pull).
const IN_PROGRESS_STATES = ["pulling", "promoting"] as const;

export type ImportState = "pulling" | "promoting" | "done" | "error";

export interface ImportRunVM {
  id: string;
  state: ImportState;
  counts: PromoteCounts | null;
  report: { imported: string[]; notIncluded: string[] } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Start an import for a shop. If one is already in progress (pulling/promoting) we return that
 * run instead of queuing a duplicate — the cron would otherwise process both and double the work.
 */
export async function startImport(shopId: string): Promise<{ importId: string }> {
  const sb = getSupabase();

  const { data: inProgress, error: checkErr } = await sb
    .from("import_run")
    .select("id")
    .eq("shop_id", shopId)
    .in("state", ["pulling", "promoting"])
    .limit(1);
  if (checkErr) throw new Error(`startImport check failed: ${checkErr.message}`);
  if (inProgress && inProgress.length) return { importId: String(inProgress[0].id) };

  const { data, error } = await sb
    .from("import_run")
    .insert({ shop_id: shopId, state: "pulling", since_days: IMPORT_WINDOW_DAYS })
    .select("id")
    .single();
  if (error) throw new Error(`startImport failed: ${error.message}`);
  return { importId: String((data as { id: string }).id) };
}

/**
 * Process every `pulling` run: pull the last `since_days` of Shopify data (reusing backfillShop),
 * flip to `promoting`, promote mirror → owned, then mark `done` with an honest report. A thrown
 * error is recorded on the run (`state='error'`) and does not abort the other runs.
 */
export async function drainImports(): Promise<{ processed: number }> {
  const sb = getSupabase();
  const { data: rows, error } = await sb
    .from("import_run")
    .select("id, shop_id, since_days, shops!inner(shop_domain)")
    .in("state", [...IN_PROGRESS_STATES])
    .limit(IMPORT_DRAIN_PER_TICK);
  if (error) throw new Error(`drainImports query failed: ${error.message}`);

  let processed = 0;
  for (const row of rows ?? []) {
    const id = String((row as { id: string }).id);
    const shopId = String((row as { shop_id: string }).shop_id);
    const sinceDays = Number((row as { since_days?: number }).since_days) || IMPORT_WINDOW_DAYS;
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      await backfillShop(domain, { sinceDays });
      const customers = await importCustomers(domain, shopId);
      // Guarded: a slow duplicate drain must never flip a finished run back
      // into an in-progress state.
      await sb
        .from("import_run")
        .update({ state: "promoting" })
        .eq("id", id)
        .in("state", [...IN_PROGRESS_STATES]);

      // The promote materializes order/refund history into imported_*; the report reads
      // its counts (what actually landed), so `backfill.orders` (the raw pull) is unused.
      const counts = await promoteShopFromMirror(shopId);
      await syncShopifyProductFacts({ shopId, shopDomain: domain });
      await syncShopifySellingPlans(domain, shopId);

      // Order<->customer relink (#13.customers): tie the just-promoted imported_order rows to the
      // buyers the customer stage re-pulled. Skipped when that stage was blocked (protected-
      // customer-data access pending) — no buyers were imported, so there is nothing to link, and
      // the PCD-gated email query would only ACCESS_DENY. Uses the same 12-month window as the pull.
      const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      const relink = customers.blocked
        ? { linked: 0, unmatched: 0 }
        : await relinkOrdersToBuyers(domain, shopId, since);
      const report = buildImportReport(counts, customers, relink);
      await sb
        .from("import_run")
        .update({ state: "done", counts, report, finished_at: new Date().toISOString() })
        .eq("id", id);
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Guarded: if a duplicate drain already finished this run, its `done`
      // must survive — an error from the losing copy is not the run's outcome.
      await sb
        .from("import_run")
        .update({ state: "error", error: message.slice(0, 500), finished_at: new Date().toISOString() })
        .eq("id", id)
        .in("state", [...IN_PROGRESS_STATES]);
    }
  }
  return { processed };
}

/**
 * Nudge the drain to run right after the current response instead of at the
 * next /cron/import tick (up to 5 minutes away). waitUntil keeps the function
 * alive on Vercel — an un-anchored promise would be frozen with the lambda;
 * outside Vercel it no-ops and the promise just runs on the event loop.
 * Best-effort: the cron remains the guarantee, and a double drain is safe
 * (runs are re-selected by state and the pull + promote are idempotent).
 */
export async function kickDrainSoon(): Promise<void> {
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(
      drainImports().catch((err) => {
        console.error("[import] post-response drain kick failed", err);
      }),
    );
  } catch (err) {
    console.error("[import] drain kick could not be scheduled", err);
  }
}

/** The latest import run for a shop, shaped for the dashboard poll. */
export async function latestImport(shopId: string): Promise<ImportRunVM | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("import_run")
    .select("id, state, counts, report, error, started_at, finished_at")
    .eq("shop_id", shopId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latestImport failed: ${error.message}`);
  if (!data) return null;

  const counts = data.counts as PromoteCounts | Record<string, never> | null;
  const hasCounts = !!counts && Object.keys(counts).length > 0;
  return {
    id: String(data.id),
    state: data.state as ImportState,
    counts: hasCounts ? (counts as PromoteCounts) : null,
    report: (data.report as ImportRunVM["report"]) ?? null,
    error: (data.error as string | null) ?? null,
    startedAt: String(data.started_at),
    finishedAt: (data.finished_at as string | null) ?? null,
  };
}
