import { getSupabase } from "../supabase.server";

export async function writeDlq(opts: {
  shopId: string | null;
  jobKind: string;
  errorKind: string;
  errorMessage: string;
  payload: unknown;
}): Promise<void> {
  const { error } = await getSupabase().from("ingestion_dlq").insert({
    shop_id: opts.shopId,
    connector: "shopify",
    job_kind: opts.jobKind,
    attempts: 1,
    error_kind: opts.errorKind,
    error_message: opts.errorMessage.slice(0, 2000),
    payload: (opts.payload ?? {}) as object,
  });
  if (error) {
    // Never let DLQ failure mask the original error; log and move on (rule 12: stay visible).
    console.error("[ingest] failed to write ingestion_dlq", error, opts.jobKind);
  }
}
