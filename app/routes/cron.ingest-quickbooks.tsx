import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { quickbooksClientForShop } from "~/lib/quickbooks/client.server";
import { syncQuickbooksCogs, type QbSyncCounts } from "~/lib/quickbooks/ingest.server";

async function setSync(shopId: string, patch: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("shop_integrations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("kind", "quickbooks");
}

async function toDlq(shopId: string, err: unknown): Promise<void> {
  const sb = getSupabase();
  const message = err instanceof Error ? err.message : String(err);
  const errorKind = /auth|token|401/i.test(message) ? "auth_expired" : "unknown";
  await sb.from("ingestion_dlq").insert({
    shop_id: shopId,
    connector: "quickbooks",
    job_kind: "items_poll",
    attempts: 1,
    error_kind: errorKind,
    error_message: message.slice(0, 500),
    payload: {},
  });
}

interface Summary {
  synced: Array<{ shopId: string } & QbSyncCounts>;
  skipped: string[];
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .in("kind", ["quickbooks"])
    .in("sync_status", ["ready", "live"]);
  if (error) throw error;

  const summary: Summary = { synced: [], skipped: [], errors: [] };

  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    const shopId = String(row.shop_id);
    try {
      const conn = await quickbooksClientForShop(shopId);
      if (!conn) {
        summary.skipped.push(shopId);
        continue;
      }
      const counts = await syncQuickbooksCogs(shopId, conn, sb);
      await setSync(shopId, { sync_status: "live", sync_error: null, last_sync_at: new Date().toISOString() });
      summary.synced.push({ shopId, ...counts });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSync(shopId, { sync_status: "error", sync_error: message.slice(0, 500) });
      await toDlq(shopId, err);
      summary.errors.push(`${shopId}: ${message}`);
      console.error(`[cron.ingest-quickbooks] sync failed for ${shopId}`, err);
    }
  }

  return json(summary);
};
