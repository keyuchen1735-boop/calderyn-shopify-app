// app/routes/app.campaigns.$campaignId.regenerate.tsx
// Action-only resource route at /app/campaigns/:campaignId/regenerate (mirrors the
// existing app.campaigns.$campaignId.score.tsx resource pattern). Runs the copy
// regenerate loop seeded from the campaign's weakest scored ad and returns ranked
// winning variants. Reuses the screener gate (gateScoreDeps), copy generator
// (pickGenerator("copy")), and the DI orchestrator. Failures surface in the JSON
// payload (rule 12), never the error boundary.
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type Variant,
} from "~/lib/screener/types";
import { loadCachedAdScorecards } from "~/lib/screener/campaign-ads.server";
import { getLatestRunForAd, saveVariants } from "~/lib/screener/runs.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { regenerateCampaignCreative } from "~/lib/screener/campaign-regen.server";

export type RegenActionPayload =
  | { ok: true; runId: string; weakestAdId: string; variants: Variant[] }
  | { ok: false; error: { code: string; message: string } };

function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || String(raw).trim() === "") return DEFAULT_SPEND_CENTS;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export type ParsedRegen =
  | { ok: true; adIds: string[]; assumedSpendCents: number }
  | { ok: false; error: { code: string; message: string } };

// PURE: FormData → { adIds, assumedSpendCents }. adIds posted as a JSON array.
export function parseRegenForm(form: FormData): ParsedRegen {
  let adIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(form.get("adIds") ?? "[]"));
    if (Array.isArray(parsed)) {
      adIds = parsed.filter((a): a is string => typeof a === "string" && a.trim() !== "");
    }
  } catch {
    adIds = [];
  }
  if (adIds.length === 0) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "adIds is required" } };
  }
  return { ok: true, adIds, assumedSpendCents: clampSpend(form.get("assumedSpendCents")) };
}

function reasonMessage(reason: "no_scored_ads" | "no_seed_run" | "generator_unavailable"): string {
  if (reason === "no_scored_ads") return "Score this campaign's ads first, then regenerate.";
  if (reason === "no_seed_run") return "Couldn't find a scored creative to improve yet.";
  return "Copy generation is unavailable right now.";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const parsed = parseRegenForm(form);
  if (!parsed.ok) return json<RegenActionPayload>({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const { calib, scoreOne, claudeDeps } = await gateScoreDeps(session.shop, parsed.assumedSpendCents);
    const generator = pickGenerator("copy", claudeDeps);
    const result = await regenerateCampaignCreative(session.shop, parsed.adIds, {
      loadCached: loadCachedAdScorecards,
      getLatestRunForAd,
      gate: { generator, scoreOne },
      styleRefs: calib.topAdNames,
      saveVariants,
      generate: generateImprovements,
    });
    if (!result.ok) {
      return json<RegenActionPayload>({
        ok: false,
        error: { code: result.reason.toUpperCase(), message: reasonMessage(result.reason) },
      });
    }
    return json<RegenActionPayload>({
      ok: true,
      runId: result.runId,
      weakestAdId: result.weakestAdId,
      variants: result.variants,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json<RegenActionPayload>({ ok: false, error: { code: "REGEN_FAILED", message } }, { status: 500 });
  }
};
