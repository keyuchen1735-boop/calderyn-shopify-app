// app/routes/dashboard.api.campaigns.$id.score.tsx
// Dashboard mirror of app.campaigns.$campaignId.score.tsx: POST JSON for one ad,
// cache-check + score + persist via loadOrScoreAdScorecards, return its
// AdScorecard. requireSameOrigin (CSRF) + requireDashboardSession (shop scope).
import type { ActionFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { loadOrScoreAdScorecards } from "~/lib/screener/campaign-ads.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
} from "~/lib/screener/types";

export type ParsedScoreBody =
  | { ok: true; adId: string; creative: CreativeInput; assumedSpendCents: number }
  | { ok: false; error: string };

function clampSpend(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

// PURE: untrusted JSON body → { adId, creative, assumedSpendCents }. Mirrors the
// embedded parseScoreForm: non-empty adId required, imageUrl ""/"null" → null,
// every other field coerced to string, spend clamped to bounds.
export function parseScoreBody(body: Record<string, unknown>): ParsedScoreBody {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  const adId = str("adId").trim();
  if (!adId) return { ok: false, error: "adId is required" };
  const imageUrlRaw = str("imageUrl").trim();
  const creative: CreativeInput = {
    imageUrl: imageUrlRaw === "" || imageUrlRaw === "null" ? null : imageUrlRaw,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta"),
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
  return { ok: true, adId, creative, assumedSpendCents: clampSpend(body.assumedSpendCents) };
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
  const parsed = parseScoreBody(body);
  if (!parsed.ok) return jsonError(422, "invalid_request", parsed.error);

  return dashboardJson(async () => {
    const [scorecard] = await loadOrScoreAdScorecards(
      session.shopId,
      [{ adId: parsed.adId, creative: parsed.creative }],
      parsed.assumedSpendCents,
    );
    return { scorecard };
  });
}
