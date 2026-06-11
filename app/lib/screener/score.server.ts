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
        description:
          "Ranked fixes, biggest lever first. Every tip is specific to THIS creative: it names the exact weakness (quoting the real headline/text/image/destination/audience), gives a ready-to-paste example written for this exact product, and states the expected effect on a named dimension. No generic ad advice, no placeholders, no hedging.",
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
    "You are given the creative's visual (an image, or key frames of a video in order), headline, primary text, CTA, destination URL, and target audience.",
    "For a video, judge hook strength primarily on the first frame and visual storytelling across the frame sequence.",
    "Score each named dimension 0-100 and give one concrete sentence of reasoning. Be opinionated and specific.",
    "When the merchant's top historical ads are provided, compare against them and reference them by name in your reasoning.",
    "",
    "Then write ranked improvement tips — biggest lever first. Each tip MUST be about THIS exact creative, never generic ad advice. Every tip has three parts:",
    "1. THE WEAKNESS — name what is actually wrong in what you were given, quoting or describing the real headline, primary text, image, destination URL, or audience (e.g. \"your headline field is blank\", \"your primary text opens with 'A serum for your skin', which states a fact instead of hooking a desire\", \"your destination is a Facebook Marketplace link, not a product page\").",
    "2. THE FIX, AS AN EXAMPLE — infer the product and brand from the image, destination, and copy, then give a ready-to-paste example written for THIS specific product: real headline text, the actual first line to use, a concrete offer. Never a placeholder like 'e.g. a benefit-led headline' — write the line out.",
    "3. THE PAYOFF — state what the fix does and which dimension it lifts (e.g. \"this gives a scroller a reason to stop in the first line, raising hook strength and CTR\").",
    "Be direct and declarative — tell the merchant exactly what to change and show them the change. Do not hedge with 'presumably', 'consider', or 'you might'. If you must reference a winning historical ad, name it and say what to copy from it specifically.",
    `Always call the ${SCORE_TOOL_NAME} tool.`,
  ].join("\n");
}

// Uploaded media arrives as data URLs (the client downscales to WebP);
// Meta-sourced creatives stay https URLs. Claude needs base64 source blocks
// for the former and url source blocks for the latter.
export function toImageBlock(url: string): Anthropic.ImageBlockParam | null {
  const dataMatch = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url);
  if (dataMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataMatch[1] as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: dataMatch[2],
      },
    };
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
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

  const frames = input.mediaKind === "video" ? (input.videoFrameUrls ?? []) : [];
  if (frames.length > 0) {
    const duration = input.videoDurationSec
      ? ` (~${Math.round(input.videoDurationSec)}s)`
      : "";
    const blocks: Anthropic.ContentBlockParam[] = [
      {
        type: "text",
        text:
          `This is a VIDEO creative${duration}. The ${frames.length} images below are key frames ` +
          "in order, start → end. The first frame is the hook the viewer sees before deciding to keep watching.",
      },
    ];
    for (const f of frames) {
      const block = toImageBlock(f);
      if (block) blocks.push(block);
    }
    blocks.push({ type: "text", text });
    return blocks;
  }

  const imageBlock = input.imageUrl ? toImageBlock(input.imageUrl) : null;
  if (!imageBlock) return text;
  return [imageBlock, { type: "text", text }];
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
