// app/lib/simulator/runs.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import type { BehaviorModel, RunStatus, SimulationRun } from "./types";

export function rowToRun(r: Record<string, unknown>): SimulationRun {
  return {
    id: String(r.id),
    status: r.status as RunStatus,
    target: String(r.target ?? "whole_store"),
    requestedN: Number(r.requested_n ?? 0),
    model: (r.model as BehaviorModel | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

// Insert a run already marked 'running' — the simulation executes synchronously
// in the same request (see the route's maxDuration config). The 'queued' status
// stays in the schema for a future move to cron-based async.
export async function startRun(
  shop: string,
  requestedN: number,
  target = "whole_store",
): Promise<SimulationRun> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("simulation_run")
    .insert({ shop_id: shopId, status: "running", requested_n: requestedN, target })
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function completeRun(shop: string, id: string, model: BehaviorModel): Promise<SimulationRun> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("simulation_run")
    .update({ status: "done", model, completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("shop_id", shopId)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function failRun(shop: string, id: string, message: string): Promise<SimulationRun> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("simulation_run")
    .update({ status: "error", error: message, completed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("shop_id", shopId)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function getLatestRun(shop: string): Promise<SimulationRun | null> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_simulation_runs")
    .select("*")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRun(data) : null;
}

// History list for the sidebar/count. NOTE: the heavy `model` blob is intentionally
// NOT selected, so every returned run has `model: null`. Use getLatestRun for the
// full model; don't read `.model` off a listRuns item.
export async function listRuns(shop: string, limit = 10): Promise<SimulationRun[]> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_simulation_runs")
    .select("id, status, target, requested_n, error, created_at, completed_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToRun);
}
