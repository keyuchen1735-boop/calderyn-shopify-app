// app/routes/dashboard.api.campaigns.$id.regenerate.tsx
// Dashboard mirror of the embedded regenerate route. Same orchestrator, same
// copy gate; JSON in / JSON out with the dashboard envelope. The orchestrator's
// typed {ok:false, reason} is returned as-is (200) so the dashboard UI can map it.
import type { ActionFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
} from "~/lib/screener/types";
import { loadCachedAdScorecards } from "~/lib/screener/campaign-ads.server";
import { getLatestRunForAd, saveVariants } from "~/lib/screener/runs.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { regenerateCampaignCreative } from "~/lib/screener/campaign-regen.server";

export type ParsedRegen =
  | { ok: true; adIds: string[]; assumedSpendCents: number }
  | { ok: false; error: { code: string; message: string } };

export function parseRegenBody(body: Record<string, unknown>): ParsedRegen {
  const adIds = Array.isArray(body.adIds)
    ? (body.adIds as unknown[]).filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  if (adIds.length === 0) {
    return { ok: false, error: { code: "invalid_request", message: "adIds is required" } };
  }
  const raw = Math.round(Number(body.assumedSpendCents));
  const assumedSpendCents = Number.isFinite(raw)
    ? Math.min(Math.max(raw, MIN_SPEND_CENTS), MAX_SPEND_CENTS)
    : DEFAULT_SPEND_CENTS;
  return { ok: true, adIds, assumedSpendCents };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const parsed = parseRegenBody(body);
  if (!parsed.ok) return jsonError(422, parsed.error.code, parsed.error.message);

  return dashboardJson(async () => {
    const { calib, scoreOne, claudeDeps } = await gateScoreDeps(session.shopId, parsed.assumedSpendCents);
    const generator = pickGenerator("copy", claudeDeps);
    const result = await regenerateCampaignCreative(session.shopId, parsed.adIds, {
      loadCached: loadCachedAdScorecards,
      getLatestRunForAd,
      gate: { generator, scoreOne },
      styleRefs: calib.topAdNames,
      saveVariants,
      generate: generateImprovements,
    });
    return result;
  });
}
