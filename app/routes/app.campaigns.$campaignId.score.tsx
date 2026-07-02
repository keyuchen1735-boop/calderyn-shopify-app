// app/routes/app.campaigns.$campaignId.score.tsx
// Action-only resource route (NO default export → renders nothing) at
// /app/campaigns/:campaignId/score. The campaign-detail page streams one POST
// here per uncached ad; we cache-check then score+persist that single ad and
// return its AdScorecard. Reusing loadOrScoreAdScorecards makes a racing
// double-submit idempotent (the cache hit short-circuits the second score).
//
// NOTE: do NOT add `export const config = { maxDuration: ... }` here — with
// v3_singleFetch a per-route config splits this into its own serverless
// function that no longer serves the single-fetch `.data` path. Set timeouts
// for the whole server function in vercel.json if the Claude path needs longer.
//
// TRUST: the creative TEXT posted here is client-supplied, but it originated
// from our own loader (Meta creatives we fetched), the score is advisory only,
// and every read/write is shop-scoped via authenticate.admin → session.shop.
// We still validate shapes and clamp spend rather than trusting the FormData.
import type { ActionFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { authenticate } from "../shopify.server";
import { loadOrScoreAdScorecards, type AdScorecard } from "~/lib/screener/campaign-ads.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
} from "~/lib/screener/types";

export type ScoreActionPayload =
  | { ok: true; scorecard: AdScorecard }
  | { ok: false; error: { code: string; message: string } };

/** Clamp a posted spend to [MIN, MAX]; absent/empty/NaN → DEFAULT. */
function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return DEFAULT_SPEND_CENTS;
  }
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

/** Coerce a posted image url: missing/""/"null" → null, else the string. */
function imageUrlOrNull(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? "").trim();
  if (s === "" || s === "null") return null;
  return s;
}

export type ParsedScoreForm =
  | { ok: true; adId: string; creative: CreativeInput; assumedSpendCents: number }
  | { ok: false; error: { code: string; message: string } };

// PURE: FormData → { adId, creative, assumedSpendCents }. Validates adId is a
// non-empty string (do not trust the posted shape), clamps spend to bounds, and
// coerces every creative field to a string (missing → ""), imageUrl → null when
// ""/"null". No I/O — unit-testable without authenticate.admin.
export function parseScoreForm(form: FormData): ParsedScoreForm {
  const str = (k: string) => String(form.get(k) ?? "");
  const adId = str("adId").trim();
  if (!adId) {
    return {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "adId is required" },
    };
  }
  const creative: CreativeInput = {
    imageUrl: imageUrlOrNull(form.get("imageUrl")),
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta"),
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
  return {
    ok: true,
    adId,
    creative,
    assumedSpendCents: clampSpend(form.get("assumedSpendCents")),
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = parseScoreForm(form);
  if (!parsed.ok) {
    return json<ScoreActionPayload>({ ok: false, error: parsed.error }, { status: 400 });
  }
  try {
    const [result] = await loadOrScoreAdScorecards(
      session.shop,
      [{ adId: parsed.adId, creative: parsed.creative }],
      parsed.assumedSpendCents,
    );
    return json<ScoreActionPayload>({ ok: true, scorecard: result });
  } catch (err) {
    // Surface the failure honestly (rule 12) — never let it 500 silently.
    const message = err instanceof Error ? err.message : String(err);
    return json<ScoreActionPayload>(
      { ok: false, error: { code: "SCORE_FAILED", message } },
      { status: 500 },
    );
  }
};
