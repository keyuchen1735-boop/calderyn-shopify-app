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
import type { RadarMoveRow } from "~/lib/radar/types";
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";

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
  competitors: { comingSoon: true };
}

const EMPTY_SIGNALS: RadarSignalsVM = {
  traffic: { yesterdayViews: 0, weeklyAverage: 0, lastCheckedAt: null },
  google: { connected: false, lastCapturedDate: null, slippingCount: 0 },
  aiAssistants: { hitsLast7: 0, hitsPrior7: 0 },
  competitors: { comingSoon: true },
};

const DAY_MS = 86_400_000;

// Each tile is best-effort: a failed read logs and zeroes that tile; the
// screen itself never breaks (same posture as the Search screen's Google card).
async function buildSignals(shopId: string): Promise<RadarSignalsVM> {
  const sb = getSupabase();
  const signals: RadarSignalsVM = structuredClone(EMPTY_SIGNALS);
  try {
    const state = await readRadarState(shopId);
    signals.traffic.lastCheckedAt = state.lastCollectedAt;
  } catch (err) {
    console.error("[radar] state read failed", err);
  }
  try {
    const { data, error } = await sb
      .from("radar_traffic_daily")
      .select("day, views")
      .eq("shop_id", shopId)
      .order("day", { ascending: false })
      .limit(8);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ day: string; views: number }>;
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
  return signals;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    if (!isUuid(session.shopId)) {
      return { moves: [], history: [], signals: structuredClone(EMPTY_SIGNALS) };
    }
    const [moves, history, signals] = await Promise.all([
      listMoves(session.shopId, ["draft"]),
      listMoves(session.shopId, ["applied", "dismissed", "expired"]),
      buildSignals(session.shopId),
    ]);
    return { moves: moves.map(toMoveVM), history: history.map(toMoveVM), signals };
  });
}

interface RadarBody {
  action?: string;
  moveId?: string;
  confirm?: boolean;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const body = (await request.json().catch(() => null)) as RadarBody | null;
  if (!body || typeof body.action !== "string" || typeof body.moveId !== "string") {
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
