// app/lib/screener/runs.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import type { CreativeScreenRun, RunSource, RunStatus, ScoreCard } from "./types";

export function rowToRun(r: Record<string, unknown>): CreativeScreenRun {
  return {
    id: String(r.id),
    status: (r.status as RunStatus) ?? "running",
    source: (r.source as RunSource) ?? "manual",
    metaAdId: (r.meta_ad_id as string | null) ?? null,
    assumedSpendCents: Number(r.assumed_spend_cents ?? 0),
    scorecard: (r.scorecard as ScoreCard | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

export async function startRun(
  shop: string,
  source: RunSource,
  assumedSpendCents: number,
  metaAdId: string | null = null,
): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("creative_screen_run")
    .insert({
      shop_id: shopId,
      status: "running",
      source,
      assumed_spend_cents: assumedSpendCents,
      meta_ad_id: metaAdId,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function completeRun(id: string, scorecard: ScoreCard): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("creative_screen_run")
    .update({ status: "done", scorecard, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function failRun(id: string, message: string): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("creative_screen_run")
    .update({ status: "error", error: message, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function getLatestRun(shop: string): Promise<CreativeScreenRun | null> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_creative_screen_runs")
    .select("*")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRun(data) : null;
}

// History list omits the heavy `scorecard` blob (every item has scorecard: null).
export async function listRuns(shop: string, limit = 10): Promise<CreativeScreenRun[]> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_creative_screen_runs")
    .select("id, status, source, meta_ad_id, assumed_spend_cents, error, created_at, completed_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToRun);
}
