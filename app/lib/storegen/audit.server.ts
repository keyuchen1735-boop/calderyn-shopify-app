// app/lib/storegen/audit.server.ts
// Generation audit (rule 12): one store_generation row per run + the raw pre-validation
// BlockPlan in store_generation_proposal. Service-role, shop-scoped; demo (non-uuid) shops skip.
import { getSupabase } from "~/lib/supabase.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GenerationRow {
  shopId: string; runId: string; source: "brief" | "catalog";
  briefText: string | null; model: string;
  status: "draft" | "failed" | "no_products"; tokenCost: number;
}

export async function recordGeneration(row: GenerationRow): Promise<void> {
  if (!UUID_RE.test(row.shopId)) return;
  const { error } = await getSupabase().from("store_generation").insert({
    shop_id: row.shopId, run_id: row.runId, source: row.source, brief_text: row.briefText,
    model: row.model, status: row.status, token_cost: row.tokenCost,
  });
  if (error) throw error;
}

export async function recordProposal(shopId: string, runId: string, plan: unknown): Promise<void> {
  if (!UUID_RE.test(shopId)) return;
  const { error } = await getSupabase().from("store_generation_proposal").upsert(
    { run_id: runId, shop_id: shopId, plan_json: plan }, { onConflict: "run_id" },
  );
  if (error) throw error;
}
