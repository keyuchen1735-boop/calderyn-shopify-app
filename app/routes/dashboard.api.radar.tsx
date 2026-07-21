// app/routes/dashboard.api.radar.tsx
// Radar screen data + move actions. Loader shapes RadarOverviewVM field-by-
// field (raw rows never reach the client - and the internal table noun never
// appears in any VM field or string). Browser-safe mirror:
// app/lib/dashboard/radar-client.ts - keep in sync by hand (search-client
// convention).
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listMoves, readRadarState } from "~/lib/radar/store.server";
import { applyMove, dismissMove, revertMove, RadarApplyError } from "~/lib/radar/apply.server";
import { collectShop } from "~/lib/radar/collect.server";
import { draftShopMoves } from "~/lib/radar/draft.server";
import { snapshotWatchingCompetitors } from "~/lib/radar/snapshot.server";
import {
  listCompetitors,
  listSnapshotTimeline,
  MAX_WATCHED_COMPETITORS,
  setCompetitorStatus,
  type SnapshotTimelineRow,
} from "~/lib/radar/competitor-store.server";
import type { CompetitorDiff, RadarCompetitorRow, RadarMoveRow } from "~/lib/radar/types";
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";

// Vercel's default function window is too short for a 15s collect slice plus
// up to RADAR_NIGHTLY_CLAUDE_CAP polish calls inside the "refresh" action
// (same convention as the sibling cron.radar-collect.tsx / cron.radar-draft.tsx).
export const config = { maxDuration: 60 };

/** A merchant-triggered "Check now" (or the screen's own stale-on-open check)
 *  is rate-limited independently of the nightly Claude quota - this only
 *  protects against refresh spam; draftShopMoves enforces its own cap. */
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;
/** How long the loader's `stale` flag treats the last check as still fresh. */
const STALE_THRESHOLD_MS = 20 * 60 * 60 * 1000;

interface RadarMoveVM {
  id: string;
  kind: string;
  status: string;
  headline: string;
  rationale: string;
  chips: string[];
  reviewOnly: boolean;
  deepLink: string | null;
  canRevert: boolean;
  reverted: boolean;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
}

function toMoveVM(m: RadarMoveRow): RadarMoveVM {
  const applyMode = String(m.payload.applyMode ?? "review");
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    headline: m.headline,
    rationale: m.rationale,
    chips: Array.isArray(m.evidence?.chips) ? m.evidence.chips.map(String) : [],
    reviewOnly: applyMode === "review",
    deepLink: typeof m.payload.deepLink === "string" ? m.payload.deepLink : null,
    canRevert: m.status === "applied" && m.priorState != null,
    reverted: m.payload.reverted === true,
    createdAt: m.createdAt,
    appliedAt: m.appliedAt,
    resolvedAt: m.resolvedAt,
  };
}

interface RadarSignalsVM {
  traffic: { yesterdayViews: number; weeklyAverage: number; lastCheckedAt: string | null };
  google: { connected: boolean; lastCapturedDate: string | null; slippingCount: number };
  aiAssistants: { hitsLast7: number; hitsPrior7: number };
  competitors: { watching: number; suggested: number; changesLast7: number; lastChangeAt: string | null };
}

const EMPTY_SIGNALS: RadarSignalsVM = {
  traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
  google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
  aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
  competitors: { watching: 0, suggested: 0, changesLast7: 0, lastChangeAt: null },
};

const DAY_MS = 86_400_000;

interface RadarCompetitorChangeVM {
  day: string; // YYYY-MM-DD
  url: string;
  chips: string[];
}

interface RadarCompetitorVM {
  id: string;
  name: string;
  host: string;
  url: string;
  status: string;
  reason: string;
  addedAt: string;
  changes: RadarCompetitorChangeVM[];
}

interface RadarCompetitorsVM {
  suggested: RadarCompetitorVM[];
  watching: RadarCompetitorVM[];
  watchLimit: number;
}

const EMPTY_COMPETITORS_VM: RadarCompetitorsVM = { suggested: [], watching: [], watchLimit: MAX_WATCHED_COMPETITORS };

/** Plain-language chips for one page diff (data shown is from the stored diff only). */
function diffChips(diff: CompetitorDiff): string[] {
  const chips: string[] = [];
  if (diff.titleChanged) chips.push("new headline");
  if (diff.newHeadings.length > 0) {
    chips.push(`${diff.newHeadings.length} new section${diff.newHeadings.length === 1 ? "" : "s"}`);
  }
  if (diff.newPrices.length > 0 || diff.removedPrices.length > 0) chips.push("prices changed");
  return chips;
}

function toCompetitorVM(c: RadarCompetitorRow, timeline: SnapshotTimelineRow[]): RadarCompetitorVM {
  let host = c.url;
  try {
    host = new URL(c.url).hostname;
  } catch {
    // keep the raw value
  }
  return {
    id: c.id,
    name: c.name || host,
    host,
    url: c.url,
    status: c.status,
    reason: typeof c.discoveryEvidence.reason === "string" ? c.discoveryEvidence.reason : "",
    addedAt: c.createdAt,
    changes: timeline
      .filter((t) => t.competitorId === c.id)
      .slice(0, 10)
      .map((t) => ({ day: t.capturedAt.slice(0, 10), url: t.url, chips: diffChips(t.diff) })),
  };
}

async function buildCompetitors(shopId: string): Promise<{ vm: RadarCompetitorsVM; timeline: SnapshotTimelineRow[] }> {
  const [suggested, watching, timeline] = await Promise.all([
    listCompetitors(shopId, ["suggested"]),
    listCompetitors(shopId, ["watching"]),
    listSnapshotTimeline(shopId),
  ]);
  return {
    vm: {
      suggested: suggested.map((c) => toCompetitorVM(c, [])),
      watching: watching.map((c) => toCompetitorVM(c, timeline)),
      watchLimit: MAX_WATCHED_COMPETITORS,
    },
    timeline,
  };
}

// Each tile is best-effort: a failed read logs and zeroes that tile; the
// screen itself never breaks (same posture as the Search screen's Google card).
async function buildSignals(
  shopId: string,
  comp: { vm: RadarCompetitorsVM; timeline: SnapshotTimelineRow[] },
): Promise<RadarSignalsVM> {
  const sb = getSupabase();
  const signals: RadarSignalsVM = structuredClone(EMPTY_SIGNALS);
  try {
    const state = await readRadarState(shopId);
    signals.traffic.lastCheckedAt = state.lastCollectedAt;
  } catch (err) {
    console.error("[radar] state read failed", err);
  }
  try {
    // radar_rollup_traffic writes a row for the CURRENT UTC day at cron time
    // (a partial, ~10h-of-data day) - exclude it here too, same as the
    // detector read boundary in collect.server.ts's loadRadarInputs, so this
    // tile always shows the last COMPLETE day, never a partial "today".
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("radar_traffic_daily")
      .select("day, views")
      .eq("shop_id", shopId)
      .lt("day", today)
      .order("day", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as Array<{ day: string; views: number }>).filter((r) => r.day < today);
    signals.traffic.yesterdayViews = rows[0]?.views ?? 0;
    const rest = rows.slice(1);
    signals.traffic.weeklyAverage = rest.length
      ? Math.round(rest.reduce((n, r) => n + r.views, 0) / rest.length)
      : 0;
  } catch (err) {
    console.error("[radar] traffic signal failed", err);
  }
  try {
    const { data, error } = await sb
      .from("seo_settings")
      .select("gsc_connected")
      .eq("shop_id", shopId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    signals.google.connected = Boolean((data as { gsc_connected?: boolean } | null)?.gsc_connected);
    if (signals.google.connected) {
      const summary = await sb.rpc("read_seo_rankings_summary", { p_shop: shopId });
      if (summary.error) throw new Error(summary.error.message);
      const s = (summary.data ?? {}) as { slipping?: unknown[]; lastCapturedDate?: string | null };
      signals.google.slippingCount = Array.isArray(s.slipping) ? s.slipping.length : 0;
      signals.google.lastCapturedDate = s.lastCapturedDate ?? null;
    }
  } catch (err) {
    console.error("[radar] google signal failed", err);
  }
  try {
    const since = new Date(Date.now() - 14 * DAY_MS).toISOString().slice(0, 10);
    const cut = new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("seo_ai_crawl_daily")
      .select("day, hits")
      .eq("shop_id", shopId)
      .gte("day", since);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ day: string; hits: number }>) {
      if (r.day >= cut) signals.aiAssistants.hitsLast7 += r.hits;
      else signals.aiAssistants.hitsPrior7 += r.hits;
    }
  } catch (err) {
    console.error("[radar] ai-assistant signal failed", err);
  }
  try {
    const weekAgo = Date.now() - 7 * DAY_MS;
    signals.competitors.watching = comp.vm.watching.length;
    signals.competitors.suggested = comp.vm.suggested.length;
    // listSnapshotTimeline is unfiltered by status (suggested/dismissed
    // competitors can still have old snapshot rows) - only count snapshots for
    // competitors currently in the watching set, so this tile always agrees
    // with what the per-card timelines show (e.g. after "Stop watching").
    const watchingIds = new Set(comp.vm.watching.map((c) => c.id));
    const watchingTimeline = comp.timeline.filter((t) => watchingIds.has(t.competitorId));
    signals.competitors.changesLast7 = watchingTimeline.filter((t) => Date.parse(t.capturedAt) >= weekAgo).length;
    signals.competitors.lastChangeAt = watchingTimeline[0]?.capturedAt ?? null;
  } catch (err) {
    console.error("[radar] competitor signal failed", err);
  }
  return signals;
}

/** true when the last check is missing or older than STALE_THRESHOLD_MS - the
 *  screen uses this to trigger an immediate per-shop check on open. */
function isStale(lastCheckedAt: string | null): boolean {
  return lastCheckedAt === null || Date.now() - Date.parse(lastCheckedAt) > STALE_THRESHOLD_MS;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    if (!isUuid(session.shopId)) {
      return {
        moves: [], history: [], signals: structuredClone(EMPTY_SIGNALS), competitors: EMPTY_COMPETITORS_VM,
        lastCheckedAt: null, stale: true,
      };
    }
    const competitorsData = await buildCompetitors(session.shopId).catch((err) => {
      console.error("[radar] competitors read failed", err);
      return { vm: EMPTY_COMPETITORS_VM, timeline: [] as SnapshotTimelineRow[] };
    });
    const [moves, history, signals] = await Promise.all([
      listMoves(session.shopId, ["draft"]),
      listMoves(session.shopId, ["applied", "dismissed", "expired"]),
      buildSignals(session.shopId, competitorsData),
    ]);
    // buildSignals already reads radar_state with its own failure isolation
    // (a state-read failure leaves signals.traffic.lastCheckedAt null, so this
    // reuses that read rather than hitting radar_state a second time).
    const lastCheckedAt = signals.traffic.lastCheckedAt;
    return {
      moves: moves.map(toMoveVM), history: history.map(toMoveVM), signals, competitors: competitorsData.vm,
      lastCheckedAt, stale: isStale(lastCheckedAt),
    };
  });
}

interface RadarBody {
  action?: string;
  moveId?: string;
  confirm?: boolean;
  competitorId?: string;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const body = (await request.json().catch(() => null)) as RadarBody | null;
  if (!body || typeof body.action !== "string") {
    return jsonError(422, "bad_request", "action and moveId are required");
  }
  if (body.action === "refresh") {
    return dashboardJson(async () => {
      const state = await readRadarState(session.shopId);
      if (state.lastCollectedAt && Date.now() - Date.parse(state.lastCollectedAt) < REFRESH_COOLDOWN_MS) {
        return { refreshed: false, reason: "fresh" as const };
      }
      // 15s collect slice, mirroring collectShop's own default budget - the
      // drafter's Claude spend is separately capped inside draftShopMoves.
      await collectShop(session.shopId, Date.now() + 15_000);
      const summary = await draftShopMoves(session.shopId);
      return { refreshed: true, drafted: summary.drafted };
    });
  }
  if (body.action === "competitor_confirm" || body.action === "competitor_dismiss") {
    if (typeof body.competitorId !== "string") {
      return jsonError(422, "bad_request", "competitorId is required");
    }
    const status = body.action === "competitor_confirm" ? ("watching" as const) : ("dismissed" as const);
    try {
      const outcome = await setCompetitorStatus(session.shopId, body.competitorId, status);
      if (outcome === "limit_reached") {
        return jsonError(422, "watch_limit",
          `You can watch up to ${MAX_WATCHED_COMPETITORS} competitors. Dismiss one first to add another.`);
      }
      if (outcome === "not_found") return jsonError(404, "competitor_not_found", "That competitor no longer exists.");
      let firstLook = false;
      if (body.action === "competitor_confirm") {
        // Best-effort: the confirm itself already succeeded above, so a
        // snapshot failure here must never turn into a failure response.
        try {
          await snapshotWatchingCompetitors(session.shopId, { deadline: Date.now() + 10_000 });
          firstLook = true;
        } catch (err) {
          console.error(`[radar] first-look snapshot failed for competitor ${body.competitorId}`, err);
        }
      }
      return dashboardJson(async () => ({
        competitors: (await buildCompetitors(session.shopId)).vm,
        ...(body.action === "competitor_confirm" ? { firstLook } : {}),
      }));
    } catch (err) {
      console.error(`[radar] ${body.action} failed for competitor ${body.competitorId}`, err);
      return jsonError(500, "radar_action_failed", "That didn't go through. Your list was not changed.");
    }
  }
  if (typeof body.moveId !== "string") {
    return jsonError(422, "bad_request", "action and moveId are required");
  }
  const { moveId } = body;
  try {
    let move: RadarMoveRow;
    switch (body.action) {
      case "apply":
        move = await applyMove({ shopId: session.shopId, moveId, actorId: session.userId ?? null });
        break;
      case "dismiss":
        move = await dismissMove({ shopId: session.shopId, moveId });
        break;
      case "revert":
        move = await revertMove({
          shopId: session.shopId,
          moveId,
          actorId: session.userId ?? null,
          confirm: body.confirm === true,
        });
        break;
      default:
        return jsonError(422, "bad_request", `unknown action: ${body.action}`);
    }
    return dashboardJson(async () => ({ move: toMoveVM(move) }));
  } catch (err) {
    if (err instanceof RadarApplyError) return jsonError(err.status, err.code, err.message);
    console.error(`[radar] ${body.action} failed for move ${moveId}`, err);
    return jsonError(500, "radar_action_failed", "The move could not be completed. Your store was not changed.");
  }
}
