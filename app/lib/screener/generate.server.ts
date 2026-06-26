// app/lib/screener/generate.server.ts
// Anti-slop generation: a CreativeGenerator produces candidate creatives from the
// scored flaws; the re-score gate judges every candidate with the SAME scorer and
// keeps only those that beat the original. Generation is never trusted blindly.
import type Anthropic from "@anthropic-ai/sdk";
import {
  normalizeTip,
  type CreativeInput, type GeneratedCandidate, type GenerationMode, type MetricScore,
  type ScoreCard, type Variant,
} from "./types";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface GenerateRequest {
  input: CreativeInput;
  weakMetrics: { label: string; score: number; reasoning: string }[];
  tips: string[];
  styleRefs: string[];
  count: number;
  /** Free-form merchant direction (style preset, art direction) appended to the brief. */
  extraDirection?: string;
}

export interface CreativeGenerator {
  mode: GenerationMode;
  available(): boolean;
  generate(req: GenerateRequest): Promise<GeneratedCandidate[]>;
}

export interface GateDeps {
  generator: CreativeGenerator;
  scoreOne: (input: CreativeInput) => Promise<{ composite: number; summary: string; metrics: MetricScore[] }>;
}

export async function generateImprovements(
  args: {
    original: CreativeInput;
    originalScorecard: ScoreCard;
    count?: number;
    styleRefs?: string[];
    extraDirection?: string;
  },
  deps: GateDeps,
): Promise<{
  variants: Variant[];
  /** Every re-scored candidate (winners AND losers), ranked best-first, so the
   *  generator UI can show each remake with its critique. */
  allScored: Variant[];
  generated: number;
  discarded: number;
  available: boolean;
}> {
  if (!deps.generator.available()) {
    return { variants: [], allScored: [], generated: 0, discarded: 0, available: false };
  }
  const weakMetrics = args.originalScorecard.metrics
    .filter((m) => m.score < 65)
    .sort((a, b) => a.score - b.score)
    .map((m) => ({ label: m.label, score: m.score, reasoning: m.reasoning }));

  const candidates = await deps.generator.generate({
    input: args.original,
    weakMetrics,
    tips: args.originalScorecard.tips.map((t) => {
      // Feed the generator the full fix (title + detail), not just the scannable
      // title — normalizeTip now splits the action line off, so the title alone
      // would drop the product-specific specifics the generator needs.
      const d = normalizeTip(t);
      return d.detail ? `${d.title} — ${d.detail}` : d.title;
    }),
    styleRefs: args.styleRefs ?? [],
    count: args.count ?? 3,
    extraDirection: args.extraDirection,
  });

  const baseline = args.originalScorecard.composite;
  // allSettled, not all: one flaky re-score must not discard every other variant.
  const settled = await Promise.allSettled(
    candidates.map(async (c): Promise<Variant> => {
      const s = await deps.scoreOne(c.input);
      return {
        mode: deps.generator.mode,
        input: c.input,
        rationale: c.rationale,
        composite: s.composite,
        delta: s.composite - baseline,
        summary: s.summary,
      };
    }),
  );
  const scored: Variant[] = settled
    .filter((r): r is PromiseFulfilledResult<Variant> => r.status === "fulfilled")
    .map((r) => r.value);

  const allScored = [...scored].sort((a, b) => b.composite - a.composite);
  const winners = allScored.filter((v) => v.composite > baseline);

  // `generated` = candidates produced; `discarded` covers both regressions and
  // re-score failures so the count never lies about what was dropped (rule 12).
  return {
    variants: winners,
    allScored,
    generated: candidates.length,
    discarded: candidates.length - winners.length,
    available: true,
  };
}

// ---- native-Claude copy generator ----

export const GENERATE_TOOL_NAME = "report_copy_variants";
const MAX_TOKENS = 2048;

const COPY_TOOL: Anthropic.Tool = {
  name: GENERATE_TOOL_NAME,
  description: "Return improved ad COPY variants (headline, primary text, CTA) that fix the named flaws.",
  input_schema: {
    type: "object",
    properties: {
      variants: {
        type: "array",
        description: "2-4 distinct improved copy variants.",
        items: {
          type: "object",
          properties: {
            headline: { type: "string" },
            primaryText: { type: "string" },
            cta: { type: "string" },
            rationale: { type: "string", description: "Which flaw this fixes and how." },
          },
          required: ["headline", "primaryText", "cta", "rationale"],
        },
      },
    },
    required: ["variants"],
  },
};

function buildPrompt(req: GenerateRequest): string {
  const weak = req.weakMetrics.length
    ? req.weakMetrics.map((m) => `- ${m.label} (${m.score}/100): ${m.reasoning}`).join("\n")
    : "- (no specific weak dimensions flagged)";
  const refs = req.styleRefs.length ? `\nMatch the style of the merchant's winning ads: ${req.styleRefs.join(", ")}.` : "";
  return [
    "Rewrite ONLY the copy (headline, primary text, CTA) of this ad to fix its weakest dimensions.",
    "Keep the same product, offer, image and destination — do NOT invent new claims or products.",
    `\nCurrent headline: ${req.input.headline}`,
    `Current primary text: ${req.input.primaryText}`,
    `Current CTA: ${req.input.cta}`,
    `Audience: ${req.input.audience}`,
    `\nWeakest dimensions to fix:\n${weak}`,
    req.tips.length ? `\nApply these fixes: ${req.tips.join("; ")}` : "",
    refs,
    `\nReturn ${req.count} distinct variants via the ${GENERATE_TOOL_NAME} tool.`,
  ].join("\n");
}

export function copyGenerator(opts: { createMessage: CreateMessageFn; model: string }): CreativeGenerator {
  return {
    mode: "copy",
    available: () => true,
    async generate(req) {
      // No cache_control here: this is a single, text-only, per-generation call
      // (the prompt is rebuilt from the creative's own flaws each time, with no
      // repeated prefix across calls), so a breakpoint would never be read — and
      // the prompt is below Sonnet 4.6's 2048-token cache minimum anyway.
      const res = await opts.createMessage({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        tools: [COPY_TOOL],
        tool_choice: { type: "tool", name: GENERATE_TOOL_NAME },
        messages: [{ role: "user", content: buildPrompt(req) }],
      });
      const toolUse = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === GENERATE_TOOL_NAME,
      );
      if (!toolUse) throw new Error("Copy generator did not return the tool call");
      const out = (toolUse.input as { variants?: unknown }).variants;
      const raw = Array.isArray(out) ? out : [];
      return raw.map((v): GeneratedCandidate => {
        const r = (v ?? {}) as Record<string, unknown>;
        return {
          input: {
            ...req.input,
            headline: typeof r.headline === "string" ? r.headline : req.input.headline,
            primaryText: typeof r.primaryText === "string" ? r.primaryText : req.input.primaryText,
            cta: typeof r.cta === "string" ? r.cta : req.input.cta,
          },
          rationale: typeof r.rationale === "string" ? r.rationale : "",
        };
      });
    },
  };
}
