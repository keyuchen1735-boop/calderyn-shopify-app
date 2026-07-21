// Persistence for radar_competitor and radar_snapshot. Service-role client,
// shop_id threaded on every query; snake_case never escapes this module.
// The unique (shop_id, url) index is the dedup backstop for discovery
// (23505 -> "duplicate"), and the (competitor_id, url, captured_day) index
// makes nightly snapshot writes idempotent.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import type {
  CompetitorDiff,
  CompetitorDiffInput,
  CompetitorExtract,
  RadarCompetitorRow,
  RadarCompetitorStatus,
} from "./types";

export const MAX_WATCHED_COMPETITORS = 5;

const DAY_MS = 86_400_000;
const COMPETITOR_COLUMNS = "id, shop_id, url, name, status, discovery_evidence, created_at, updated_at";

function mapCompetitor(r: Record<string, unknown>): RadarCompetitorRow {
  return {
    id: String(r.id),
    shopId: String(r.shop_id),
    url: String(r.url),
    name: String(r.name ?? ""),
    status: r.status as RadarCompetitorStatus,
    discoveryEvidence: (r.discovery_evidence ?? {}) as Record<string, unknown>,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listCompetitors(
  shopId: string,
  statuses: RadarCompetitorStatus[],
  limit = 50,
): Promise<RadarCompetitorRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_competitor")
    .select(COMPETITOR_COLUMNS)
    .eq("shop_id", shopId)
    .in("status", statuses)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listCompetitors: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(mapCompetitor);
}

export async function countCompetitors(shopId: string, status: RadarCompetitorStatus): Promise<number> {
  if (!isUuid(shopId)) return 0;
  const { count, error } = await getSupabase()
    .from("radar_competitor")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("status", status);
  if (error) throw new Error(`countCompetitors: ${error.message}`);
  return count ?? 0;
}

export async function insertSuggestion(
  shopId: string,
  s: { url: string; name: string; evidence: Record<string, unknown> },
): Promise<"inserted" | "duplicate"> {
  if (!isUuid(shopId)) throw new Error(`insertSuggestion requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("radar_competitor").insert({
    shop_id: shopId,
    url: s.url,
    name: s.name,
    status: "suggested",
    discovery_evidence: s.evidence,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") return "duplicate";
    throw new Error(`insertSuggestion: ${error.message}`);
  }
  return "inserted";
}

/** Count-then-update has a benign race (two concurrent confirms could briefly
 *  reach 6 watched) - acceptable for a single-merchant dashboard action. */
export async function setCompetitorStatus(
  shopId: string,
  competitorId: string,
  status: RadarCompetitorStatus,
): Promise<"updated" | "not_found" | "limit_reached"> {
  if (!isUuid(shopId) || !isUuid(competitorId)) return "not_found";
  if (status === "watching") {
    const watching = await countCompetitors(shopId, "watching");
    if (watching >= MAX_WATCHED_COMPETITORS) return "limit_reached";
  }
  const { data, error } = await getSupabase()
    .from("radar_competitor")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", competitorId)
    .select("id");
  if (error) throw new Error(`setCompetitorStatus: ${error.message}`);
  return (data ?? []).length > 0 ? "updated" : "not_found";
}

/** Bump a competitor's updated_at after it is snapshotted, so listCompetitors'
 *  stalest-first (updated_at asc) ordering rotates the tail in on the next run.
 *  Without this the same competitors sort first every night and any beyond the
 *  per-run fetch budget are starved permanently. Best-effort: a failure here is
 *  logged, never fatal to the snapshot run. */
export async function touchCompetitorSnapshot(shopId: string, competitorId: string): Promise<void> {
  if (!isUuid(shopId) || !isUuid(competitorId)) return;
  const { error } = await getSupabase()
    .from("radar_competitor")
    .update({ updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", competitorId);
  if (error) throw new Error(`touchCompetitorSnapshot: ${error.message}`);
}

export interface SnapshotBaseline {
  contentHash: string;
  extracted: CompetitorExtract;
}

/** Newest stored snapshot per url for one competitor (the hash gate's input). */
export async function latestSnapshots(shopId: string, competitorId: string): Promise<Map<string, SnapshotBaseline>> {
  if (!isUuid(shopId) || !isUuid(competitorId)) return new Map();
  const { data, error } = await getSupabase()
    .from("radar_snapshot")
    .select("url, content_hash, extracted")
    .eq("shop_id", shopId)
    .eq("competitor_id", competitorId)
    .order("captured_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`latestSnapshots: ${error.message}`);
  const map = new Map<string, SnapshotBaseline>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const url = String(r.url);
    if (map.has(url)) continue; // newest-first: first row per url wins
    map.set(url, {
      contentHash: String(r.content_hash),
      extracted: (r.extracted ?? { title: "", metaDescription: "", headings: [], prices: [] }) as CompetitorExtract,
    });
  }
  return map;
}

export async function insertSnapshot(
  shopId: string,
  snap: { competitorId: string; url: string; contentHash: string; extracted: CompetitorExtract; diff: CompetitorDiff | null },
): Promise<void> {
  if (!isUuid(shopId)) return;
  const { error } = await getSupabase().from("radar_snapshot").upsert(
    {
      shop_id: shopId,
      competitor_id: snap.competitorId,
      url: snap.url,
      captured_at: new Date().toISOString(),
      content_hash: snap.contentHash,
      extracted: snap.extracted,
      diff: snap.diff,
    },
    { onConflict: "competitor_id,url,captured_day" },
  );
  if (error) throw new Error(`insertSnapshot: ${error.message}`);
}

function mapDiff(r: Record<string, unknown>, names: Map<string, string>): CompetitorDiffInput {
  return {
    competitorId: String(r.competitor_id),
    competitorName: names.get(String(r.competitor_id)) ?? "A competitor",
    url: String(r.url),
    capturedAt: String(r.captured_at),
    diff: r.diff as CompetitorDiff,
  };
}

/** Recent changed-page rows for WATCHING competitors, joined with names in
 *  code (two bounded queries; no PostgREST embedded joins). */
export async function listRecentDiffs(shopId: string, sinceDays = 7, limit = 100): Promise<CompetitorDiffInput[]> {
  if (!isUuid(shopId)) return [];
  const watching = await listCompetitors(shopId, ["watching"], MAX_WATCHED_COMPETITORS);
  if (watching.length === 0) return [];
  const names = new Map(watching.map((c) => [c.id, c.name || new URL(c.url).hostname]));
  const { data, error } = await getSupabase()
    .from("radar_snapshot")
    .select("competitor_id, url, captured_at, diff")
    .eq("shop_id", shopId)
    .in("competitor_id", watching.map((c) => c.id))
    .not("diff", "is", null)
    .gte("captured_at", new Date(Date.now() - sinceDays * DAY_MS).toISOString())
    .order("captured_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRecentDiffs: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => mapDiff(r, names));
}

export interface SnapshotTimelineRow {
  competitorId: string;
  url: string;
  capturedAt: string;
  diff: CompetitorDiff;
}

/** Change timeline for the Competitors tab (30-day window, bounded). */
export async function listSnapshotTimeline(shopId: string, limit = 50): Promise<SnapshotTimelineRow[]> {
  if (!isUuid(shopId)) return [];
  const { data, error } = await getSupabase()
    .from("radar_snapshot")
    .select("competitor_id, url, captured_at, diff")
    .eq("shop_id", shopId)
    .not("diff", "is", null)
    .gte("captured_at", new Date(Date.now() - 30 * DAY_MS).toISOString())
    .order("captured_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listSnapshotTimeline: ${error.message}`);
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    competitorId: String(r.competitor_id),
    url: String(r.url),
    capturedAt: String(r.captured_at),
    diff: r.diff as CompetitorDiff,
  }));
}
