import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { drainImports } from "~/lib/import/run.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Import-from-Shopify drain, on its own cron so it gets a full function budget.
// It used to ride /cron/ingest as the last phase, but that tick can exhaust the
// 300s function ceiling on its earlier phases, which starves the drain and leaves
// merchant-visible import runs in `pulling` forever. A pending import is a merchant
// waiting on a progress screen, so it must not compete with background analytics
// for time. The drain is a single cheap query when nothing is pending.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary = {
    imports: { processed: 0 },
    importError: null as string | null,
  };
  const startedAt = Date.now();
  try {
    summary.imports = await drainImports();
  } catch (err) {
    summary.importError = err instanceof Error ? err.message : String(err);
    console.error("[cron.import] import drain failed", err);
  }
  // Logged (not just returned) so a tick the platform kills at the function
  // ceiling still leaves a trail of what the completed ticks around it cost.
  console.log(
    `[cron.import] drained ${summary.imports.processed} run(s) in ${Date.now() - startedAt}ms`,
  );
  return json(summary);
};
