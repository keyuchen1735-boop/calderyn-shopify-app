import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { runSourcingIngest } from "~/lib/sourcing/ingest.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Nightly viral-product ingest. Pulls trending products via the provider-blind
// SupplierAdapter, scores them deterministically (no model in the ranking loop),
// and upserts the global source tables. A single cheap batch on its own cron
// budget, mirroring cron.import.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const result = await runSourcingIngest();
    console.log(
      `[cron.sourcing] ingested ${result.scored}/${result.fetched} in ${Date.now() - startedAt}ms`,
    );
    return json(result);
  } catch (err) {
    console.error("[cron.sourcing] ingest failed", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
};
