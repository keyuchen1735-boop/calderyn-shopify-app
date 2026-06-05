// app/lib/simulator/simulate.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import {
  FUNNEL_STAGES,
  type Archetype,
  type BehaviorModel,
  type Finding,
  type FunnelStageId,
  type Severity,
  type StoreSnapshot,
} from "./types";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

const TOOL_NAME = "report_simulation";
const MAX_TOKENS = 4096;
const SEVERITIES: Severity[] = ["critical", "high", "low"];
// Only the non-terminal stages have an "advance to next" probability. `bought` is
// terminal — reaching it IS the conversion — so we don't ask Claude for advance.bought
// (it would be collected but never read by the sampler).
const ADVANCE_STAGES = FUNNEL_STAGES.slice(0, -1);

/** Forced-output tool: Claude must call this with the behavior model. */
export const REPORT_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Report the simulated shopper behavior model for this store: archetypes with per-stage advance probabilities, and ranked friction findings.",
  input_schema: {
    type: "object",
    properties: {
      storeSummary: { type: "string", description: "One sentence reading of the store." },
      archetypes: {
        type: "array",
        description: "About 8 distinct shopper archetypes tailored to this store.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "kebab-case slug" },
            name: { type: "string" },
            weight: { type: "number", description: "population share 0..1" },
            advance: {
              type: "object",
              description:
                "Probability (0..1) of advancing FROM each stage to the next one: landed→viewed_product, viewed_product→added_to_cart, added_to_cart→started_checkout, started_checkout→shipping_reveal, shipping_reveal→bought. (bought is terminal — omit it. Put final-checkout/payment friction into shipping_reveal.)",
              properties: Object.fromEntries(ADVANCE_STAGES.map((s) => [s, { type: "number" }])),
            },
            dropReason: {
              type: "object",
              description: "Short reason this archetype bounces at a stage (keyed by stage id).",
              properties: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, { type: "string" }])),
            },
          },
          required: ["id", "name", "weight", "advance"],
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            severity: { type: "string", enum: SEVERITIES },
            title: { type: "string" },
            stage: { type: "string", enum: [...FUNNEL_STAGES] },
            personaIds: { type: "array", items: { type: "string" } },
            fix: { type: "string" },
          },
          required: ["id", "severity", "title", "stage", "personaIds", "fix"],
        },
      },
    },
    required: ["storeSummary", "archetypes", "findings"],
  },
};

export function buildSystemPrompt(): string {
  return [
    "You simulate a population of online shoppers walking a Shopify store and predict where they drop off.",
    "You are given the store's real homepage text, a representative product, and the shipping cost shown at checkout.",
    "Invent ~8 distinct, realistic shopper archetypes tailored to THIS store's category (e.g. deal-hunter, gift-buyer, skeptical first-timer, comparison researcher, impatient mobile shopper, loyal repeat-buyer).",
    "For each archetype, estimate the probability of advancing through each funnel stage. Be opinionated: weak value props, thin product info, and surprise shipping costs should LOWER the relevant advance probabilities.",
    "Then summarise the biggest friction points as findings, each tied to the stage and the archetypes it hurts, with a concrete fix.",
    `Always call the ${TOOL_NAME} tool.`,
  ].join("\n");
}

function buildUserMessage(s: StoreSnapshot): string {
  const product = s.product
    ? `Product: ${s.product.title}\nPrice: ${s.product.priceText}\nDescription: ${s.product.descriptionText}`
    : "No product page could be read.";
  const ship = s.shipping.estimated
    ? `Shipping at checkout: ~${s.shipping.amount} ${s.shipping.currency} (estimated)`
    : `Shipping at checkout: ${s.shipping.amount} ${s.shipping.currency}`;
  return `Store: ${s.shop}\n\nHomepage:\n${s.homeText}\n\n${product}\n\n${ship}`;
}

function clamp01(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function normalizeArchetype(raw: unknown): Archetype | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const advanceIn = (r.advance ?? {}) as Record<string, unknown>;
  const advance = {} as Record<FunnelStageId, number>;
  for (const stage of FUNNEL_STAGES) advance[stage] = clamp01(advanceIn[stage]);
  const dropIn = (r.dropReason ?? {}) as Record<string, unknown>;
  const dropReason: Archetype["dropReason"] = {};
  for (const stage of FUNNEL_STAGES) {
    if (typeof dropIn[stage] === "string") dropReason[stage] = dropIn[stage] as string;
  }
  return { id: r.id, name: r.name, weight: clamp01(r.weight), advance, dropReason };
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return null;
  const stage = FUNNEL_STAGES.includes(r.stage as FunnelStageId) ? (r.stage as FunnelStageId) : "landed";
  const severity = SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : "low";
  const personaIds = Array.isArray(r.personaIds) ? r.personaIds.filter((x): x is string => typeof x === "string") : [];
  return { id: r.id, severity, title: r.title, stage, personaIds, fix: typeof r.fix === "string" ? r.fix : "" };
}

export function parseBehaviorModel(
  input: unknown,
  shipping: BehaviorModel["shipping"],
): BehaviorModel {
  const obj = (input ?? {}) as Record<string, unknown>;
  const archetypes = Array.isArray(obj.archetypes)
    ? obj.archetypes.map(normalizeArchetype).filter((a): a is Archetype => a !== null)
    : [];
  if (archetypes.length === 0) throw new Error("Simulation returned no usable archetypes");
  const findings = Array.isArray(obj.findings)
    ? obj.findings.map(normalizeFinding).filter((f): f is Finding => f !== null)
    : [];
  return {
    storeSummary: typeof obj.storeSummary === "string" ? obj.storeSummary : "",
    shipping,
    archetypes,
    findings,
  };
}

export async function buildBehaviorModel(
  snapshot: StoreSnapshot,
  opts: { createMessage: CreateMessageFn; model: string },
): Promise<BehaviorModel> {
  const res = await opts.createMessage({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildUserMessage(snapshot) }],
  });
  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
  );
  if (!toolUse) throw new Error("Simulation did not return a report_simulation tool call");
  return parseBehaviorModel(toolUse.input, snapshot.shipping);
}
