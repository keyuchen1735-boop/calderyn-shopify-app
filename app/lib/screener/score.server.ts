// app/lib/screener/score.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import { DIMENSIONS, type CreativeInput, type MetricScore } from "./types";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export const SCORE_TOOL_NAME = "report_creative_score";
const MAX_TOKENS = 4096;

export const SCORE_TOOL: Anthropic.Tool = {
  name: SCORE_TOOL_NAME,
  description:
    "Report the pre-launch score for this ad creative: a 0-100 score with one-sentence reasoning for each named dimension, a one-line summary, and ranked improvement tips.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One-sentence read of the creative." },
      dimensions: {
        type: "object",
        description: "Keyed by dimension id; each value has score (0-100) and reasoning.",
        properties: Object.fromEntries(
          DIMENSIONS.map((d) => [
            d.id,
            {
              type: "object",
              properties: {
                score: { type: "number", description: `0-100 for ${d.label}` },
                reasoning: { type: "string" },
              },
              required: ["score", "reasoning"],
            },
          ]),
        ),
      },
      tips: {
        type: "array",
        items: { type: "string" },
        description: "Ranked, concrete fixes, biggest lever first.",
      },
    },
    required: ["summary", "dimensions", "tips"],
  },
};

const clamp100 = (x: unknown): number => {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.round(n), 0), 100);
};

export function buildScoreCardMetrics(dimensions: unknown): MetricScore[] {
  const d = (dimensions ?? {}) as Record<string, { score?: unknown; reasoning?: unknown }>;
  return DIMENSIONS.map((dim) => {
    const raw = d[dim.id] ?? {};
    return {
      id: dim.id,
      group: dim.group,
      label: dim.label,
      score: clamp100(raw.score),
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    };
  });
}

export function buildSystemPrompt(): string {
  return [
    "You are an expert direct-response ad reviewer. Score an ad creative BEFORE it runs.",
    "You are given the creative's image (if any), headline, primary text, CTA, destination URL, and target audience.",
    "Score each named dimension 0-100 and give one concrete sentence of reasoning. Be opinionated and specific.",
    "When the merchant's top historical ads are provided, compare against them and reference them by name in your reasoning.",
    "Then give ranked, concrete improvement tips — biggest lever first.",
    `Always call the ${SCORE_TOOL_NAME} tool.`,
  ].join("\n");
}

export function buildUserContent(
  input: CreativeInput,
  topAdNames: string[],
): Anthropic.MessageParam["content"] {
  const text =
    `Headline: ${input.headline}\n` +
    `Primary text: ${input.primaryText}\n` +
    `CTA: ${input.cta}\n` +
    `Destination: ${input.destinationUrl}\n` +
    `Audience: ${input.audience}\n` +
    (topAdNames.length ? `\nMerchant's top historical ads: ${topAdNames.join(", ")}` : "\nNo historical ads available.");

  if (!input.imageUrl) return text;
  return [
    { type: "image", source: { type: "url", url: input.imageUrl } },
    { type: "text", text },
  ];
}

export async function scoreCreative(
  input: CreativeInput,
  topAdNames: string[],
  opts: { createMessage: CreateMessageFn; model: string },
): Promise<{ summary: string; metrics: MetricScore[]; tips: string[] }> {
  const res = await opts.createMessage({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: SCORE_TOOL_NAME },
    messages: [{ role: "user", content: buildUserContent(input, topAdNames) }],
  });
  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SCORE_TOOL_NAME,
  );
  if (!toolUse) throw new Error("Scorer did not return a report_creative_score tool call");
  const out = toolUse.input as { summary?: unknown; dimensions?: unknown; tips?: unknown };
  return {
    summary: typeof out.summary === "string" ? out.summary : "",
    metrics: buildScoreCardMetrics(out.dimensions),
    tips: Array.isArray(out.tips) ? out.tips.filter((t): t is string => typeof t === "string") : [],
  };
}
