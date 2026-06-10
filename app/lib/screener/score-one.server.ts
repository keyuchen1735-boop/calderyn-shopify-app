// app/lib/screener/score-one.server.ts
// Shared construction of the re-score gate's `scoreOne` (Claude scoring +
// deterministic calibration) so the screener and generator actions can't drift.
import { getAnthropic, assistantModel } from "../assistant/anthropic.server";
import { loadCalibrationInputs } from "./history.server";
import { scoreCreative, type CreateMessageFn } from "./score.server";
import { calibrate } from "./calibrate.server";
import type { CalibrationInputs, CreativeInput, MetricScore } from "./types";

export async function gateScoreDeps(
  shop: string,
  assumedSpendCents: number,
): Promise<{
  calib: CalibrationInputs;
  scoreOne: (
    input: CreativeInput,
  ) => Promise<{ composite: number; summary: string; metrics: MetricScore[] }>;
  /** The Claude deps generators need (e.g. pickGenerator's copy generator). */
  claudeDeps: { createMessage: CreateMessageFn; model: string };
}> {
  const calib = await loadCalibrationInputs(shop, null);
  const createMessage: CreateMessageFn = (p) => getAnthropic().messages.create(p);
  const model = assistantModel();
  const scoreOne = async (input: CreativeInput) => {
    const scored = await scoreCreative(input, calib.topAdNames, { createMessage, model });
    const { composite } = calibrate(scored.metrics, calib, assumedSpendCents);
    return { composite, summary: scored.summary, metrics: scored.metrics };
  };
  return { calib, scoreOne, claudeDeps: { createMessage, model } };
}
