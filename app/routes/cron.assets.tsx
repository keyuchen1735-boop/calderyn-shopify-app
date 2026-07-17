import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { generateMissingProductImages } from "~/lib/assets/generate-missing.server";
import { sweepPendingMedia } from "~/lib/assets/rehost.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

// Asset maintenance sweep (#9). Captures hotlinked product_media images
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
    const [rehost, generation] = await Promise.all([
      sweepPendingMedia(),
      generateMissingProductImages(),
    ]);
    console.log(
      `[cron.assets] rehosted ${rehost.rehosted}/${rehost.scanned} ` +
        `(${rehost.failed} failed, ${rehost.orphaned} orphaned, ${rehost.deduped} deduped); ` +
        `generated ${generation.ready}/${generation.claimed} (${generation.failed} failed, ${generation.skipped} skipped) ` +
        `in ${Date.now() - startedAt}ms`,
    );
    return json({ rehost, generation });
  } catch (err) {
    console.error("[cron.assets] run failed", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
};
