// app/lib/screener/score.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import { DIMENSIONS, type CreativeInput, type MetricScore, type TipDetail } from "./types";

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
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "A short imperative action line, max 8 words, no trailing period (e.g. \"Add a benefit-led headline\", \"Swap the Marketplace link for a PDP\"). This is what the merchant scans first.",
            },
            detail: {
              type: "string",
              description:
                "The specifics behind the title: name the exact weakness (quote the real headline/text/image/destination/audience), give a ready-to-paste example written for THIS product, and state the expected effect on a named dimension. No generic advice, no placeholders, no hedging.",
            },
          },
          required: ["title", "detail"],
        },
        description: "Ranked fixes, biggest lever first. 3-5 tips. Each is specific to THIS creative.",
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
    "Then write 3-5 ranked improvement tips — biggest lever first. Each tip MUST be about THIS exact creative, never generic ad advice. Each tip has a `title` and a `detail`:",
    "- `title`: a short imperative action line, max 8 words, no trailing period — the one thing to do (e.g. \"Add a benefit-led headline\", \"Hook the first line before 'See More'\", \"Swap the Marketplace link for a PDP\"). The merchant scans these first, so make them sharp and scannable.",
    "- `detail`: the specifics behind the title, in 1-3 sentences with three beats: (1) THE WEAKNESS — name what is actually wrong, quoting the real headline/primary text/image/destination/audience (e.g. \"your headline field is blank\", \"your destination is a Facebook Marketplace link, not a product page\"); (2) THE FIX AS AN EXAMPLE — infer the product/brand and write a ready-to-paste line for THIS product (real headline text, the actual first line, a concrete offer — never a placeholder like 'e.g. a benefit-led headline'); (3) THE PAYOFF — what the fix does and which named dimension it lifts.",
    "Keep the `title` short and the `detail` specific. Be direct and declarative — do not hedge with 'presumably', 'consider', or 'you might'. If you reference a winning historical ad, name it and say what to copy from it specifically.",
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
    const intro: Anthropic.TextBlockParam = {
      type: "text",
      text:
        `This is a VIDEO creative${duration}. The ${frames.length} images below are key frames ` +
        "in order, start → end. The first frame is the hook the viewer sees before deciding to keep watching.",
    };
    const imageBlocks: Anthropic.ImageBlockParam[] = [];
    for (const f of frames) {
      const block = toImageBlock(f);
      if (block) imageBlocks.push(block);
    }
    // Cache the prefix up to and including the LAST frame, so the cached span is
    // tools + system + intro + every frame. The re-score gate replays the same
    // media with different copy text, so this prefix is identical across calls;
    // only the trailing creative-copy text below varies and stays uncached.
    const lastImage = imageBlocks[imageBlocks.length - 1];
    if (lastImage) lastImage.cache_control = { type: "ephemeral" };
    return [intro, ...imageBlocks, { type: "text", text }];
  }

  const imageBlock = input.imageUrl ? toImageBlock(input.imageUrl) : null;
  // Text-only fallback: a plain string can't carry a cache_control breakpoint,
  // and without media the system+tools prefix (~1.4k tokens) is below Sonnet
  // 4.6's 2048-token cache minimum anyway — so there is nothing to cache here.
  if (!imageBlock) return text;
  // Breakpoint on the image → cached prefix is tools + system + image, stable
  // across re-scores of this creative; the trailing copy text varies, so leave
  // it after the breakpoint (uncached).
  imageBlock.cache_control = { type: "ephemeral" };
  return [imageBlock, { type: "text", text }];
}

export async function scoreCreative(
  input: CreativeInput,
  topAdNames: string[],
  opts: { createMessage: CreateMessageFn; model: string },
): Promise<{ summary: string; metrics: MetricScore[]; tips: TipDetail[] }> {
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
    tips: parseTips(out.tips),
  };
}

/** Coerce the tool's `tips` into TipDetail[], tolerating legacy string tips and
 *  partial objects. Drops tips with no title (rule 12: skip the unusable, don't
 *  render an empty bullet). */
export function parseTips(raw: unknown): TipDetail[] {
  if (!Array.isArray(raw)) return [];
  const tips: TipDetail[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      if (t.trim()) tips.push({ title: t.trim(), detail: "" });
    } else if (t && typeof t === "object") {
      const o = t as { title?: unknown; detail?: unknown };
      const title = typeof o.title === "string" ? o.title.trim() : "";
      const detail = typeof o.detail === "string" ? o.detail.trim() : "";
      if (title) tips.push({ title, detail });
    }
  }
  return tips;
}
