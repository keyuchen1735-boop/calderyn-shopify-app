// app/lib/screener/orchestrate.server.ts
import { getAnthropic, assistantModel } from "../assistant/anthropic.server";
import { parseLandingSite } from "../attribution/parse";
import { calibrate } from "./calibrate.server";
import { loadCalibrationInputs as realLoad } from "./history.server";
import { scoreCreative as realScore } from "./score.server";
import { startRun as realStart, completeRun as realComplete, failRun as realFail } from "./runs.server";
import type {
  CalibrationInputs, CreativeInput, CreativeScreenRun, RunSource, ScoreCard, TipDetail,
} from "./types";

export interface ScreenDeps {
  resolveSku: (destinationUrl: string) => string | null;
  loadCalibrationInputs: (shop: string, mappedSku: string | null) => Promise<CalibrationInputs>;
  scoreCreative: (
    input: CreativeInput,
    topAdNames: string[],
  ) => Promise<{ summary: string; metrics: ScoreCard["metrics"]; tips: TipDetail[] }>;
  startRun: (shop: string, source: RunSource, assumedSpendCents: number, metaAdId?: string | null) => Promise<CreativeScreenRun>;
  completeRun: (shop: string, id: string, scorecard: ScoreCard, creativeInput: CreativeInput) => Promise<CreativeScreenRun>;
  failRun: (shop: string, id: string, message: string) => Promise<CreativeScreenRun>;
}

/** Best-effort creative→SKU from the destination URL's UTM tags. */
function resolveSkuFromUrl(destinationUrl: string): string | null {
  try {
    const { utm } = parseLandingSite(destinationUrl);
    // utm_content commonly carries the SKU/variant; fall back to utm_campaign.
    return utm.utm_content ?? utm.utm_campaign ?? null;
  } catch {
    return null;
  }
}

function defaultDeps(): ScreenDeps {
  return {
    resolveSku: resolveSkuFromUrl,
    loadCalibrationInputs: realLoad,
    scoreCreative: (input, topAdNames) =>
      realScore(input, topAdNames, {
        createMessage: (p) => getAnthropic().messages.create(p),
        model: assistantModel(),
      }),
    startRun: realStart,
    completeRun: realComplete,
    failRun: realFail,
  };
}

export async function executeScreen(
  args: { shop: string; input: CreativeInput; assumedSpendCents: number; source?: RunSource; metaAdId?: string | null },
  deps: ScreenDeps = defaultDeps(),
): Promise<CreativeScreenRun> {
  const source: RunSource = args.source ?? "manual";
  const metaAdId = args.metaAdId ?? null;
  let run: CreativeScreenRun | null = null;
  try {
    run = await deps.startRun(args.shop, source, args.assumedSpendCents, metaAdId);
    const mappedSku = deps.resolveSku(args.input.destinationUrl);
    const calib = await deps.loadCalibrationInputs(args.shop, mappedSku);
    const scored = await deps.scoreCreative(args.input, calib.topAdNames);
    const { outcomes, composite, grade, confidence } = calibrate(
      scored.metrics,
      calib,
      args.assumedSpendCents,
    );
    const scorecard: ScoreCard = {
      composite, grade, confidence,
      summary: scored.summary,
      metrics: scored.metrics,
      outcomes,
      tips: scored.tips,
    };
    return await deps.completeRun(args.shop, run.id, scorecard, args.input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run) {
      try {
        return await deps.failRun(args.shop, run.id, message);
      } catch {
        // failRun itself failed — fall through to a synthetic error DTO.
      }
    }
    return {
      id: run?.id ?? "",
      status: "error",
      source,
      metaAdId,
      assumedSpendCents: args.assumedSpendCents,
      scorecard: null,
      error: message,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      creativeInput: null,
      variants: [],
    };
  }
}
