import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { sweepPendingMedia } from "~/lib/assets/rehost.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Nightly asset rehost sweep (#9). Captures hotlinked product_media images
// (Shopify CDN rows from promote, supplier CDN rows from sourcing picks) into
// owned storage so catalog imagery survives upstream URL death. A single cheap
// batch on its own cron budget, mirroring cron.sourcing.
// Worst case is CONCURRENCY-parallel 15s fetches over a 50-row batch — well
// under 300s, but declare it like the other long crons instead of trusting
// the platform default.
export const config = { maxDuration: 300 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const result = await sweepPendingMedia();
    console.log(
      `[cron.assets] rehosted ${result.rehosted}/${result.scanned} ` +
        `(${result.failed} failed, ${result.orphaned} orphaned, ${result.deduped} deduped) ` +
        `in ${Date.now() - startedAt}ms`,
    );
    return json(result);
  } catch (err) {
    console.error("[cron.assets] sweep failed", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
};
