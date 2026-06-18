// Plain-English "why" for a campaign's recommended direction. The direction is
// ALREADY decided by recommendDirection — this layer only phrases it. Claude does
// the phrasing when available (directionReason); directionTemplate is the
// deterministic fallback, in the no-jargon house style of scale-reason.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";
import {
  recommendDirection,
  buildDirectionInput,
  suggestBudgetCents,
  type Direction,
  type DirectionActionKind,
} from "./direction.server";
import type { Alert } from "~/lib/types";

export interface ReasonFacts {
  roas: number | null;
  breakEvenRoas: number | null;
  dataSufficient: boolean;
  status: "active" | "paused";
}

function x(n: number | null): string {
  return n != null && Number.isFinite(n) ? `${n.toFixed(1)}×` : "—";
}

export function directionTemplate(direction: Direction, f: ReasonFacts): string {
  if (!f.dataSufficient) return "Not enough recent spend or margin data to make a call yet.";
  if (f.status === "paused") return "This campaign is paused — no change recommended right now.";
  const ret = x(f.roas);
  const be = x(f.breakEvenRoas);
  switch (direction) {
    case "scale_up":
      return `Winning campaign — earning ${ret} on ad spend, above the ${be} it needs to break even. Give the winner more budget.`;
    case "scale_down":
      return `Underperforming — ${ret} on ad spend is below the ${be} it needs to break even. Trim the budget to cut the bleed.`;
    case "pause":
      return `Losing money — ${ret} is well under the ${be} break-even. Pause it before it spends more.`;
    case "keep":
    default:
      return `Holding steady — ${ret} on ad spend is around the ${be} break-even. Keep the budget and keep watching.`;
  }
}

export interface CampaignDirection {
  direction: Direction;
  actionKind: DirectionActionKind | null;
  suggestedBudgetCents: number | null;
  reason: string;
  reasonSource: "claude" | "template";
  dataSufficient: boolean;
}

const DIRECTION_VERB: Record<Direction, string> = {
  scale_up: "scale this campaign up (raise its budget)",
  scale_down: "scale this campaign down (cut its budget)",
  keep: "keep this campaign as-is",
  pause: "pause this campaign",
};

/** ONE sentence from Claude explaining an already-decided direction. Claude is
 *  told the decision as a fact; it never chooses. Throws on any API error so the
 *  caller falls back to the template. */
async function directionReason(direction: Direction, f: ReasonFacts): Promise<string> {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: assistantModel(),
    max_tokens: 120,
    system:
      "You explain an already-decided ad-campaign budget decision to a Shopify merchant in ONE short, plain-English sentence (≤30 words). " +
      "The decision is final — never question, hedge, or contradict it. No jargon (say 'earning 1.5× on ad spend', never 'ROAS'). Invent no numbers beyond those given.",
    messages: [
      {
        role: "user",
        content:
          `Decision: ${DIRECTION_VERB[direction]}.\n` +
          `Return on ad spend: ${f.roas != null ? f.roas.toFixed(2) + "×" : "unknown"}. ` +
          `Break-even return: ${f.breakEvenRoas != null ? f.breakEvenRoas.toFixed(2) + "×" : "unknown"}. ` +
          `Write the one sentence.`,
      },
    ],
  });
  const block = Array.isArray(msg.content) ? msg.content.find((b: { type: string }) => b.type === "text") : null;
  const text = block && "text" in block ? String((block as { text: string }).text).trim() : "";
  if (!text) throw new Error("empty Claude response");
  return text;
}

export async function resolveCampaignDirection(args: {
  shopId: string;
  campaignId: string;
  roas: number | null;
  breakEvenRoas: number | null;
  contributionMargin: number | null;
  status: "active" | "paused";
  currentBudgetCents: number | null;
  alerts: Pick<Alert, "detector_id" | "status" | "campaign_id">[];
  guardrails: {
    autopilot_max_budget_increase_pct?: number | null;
    autopilot_max_budget_cut_pct?: number | null;
    autopilot_max_daily_budget_cents?: number | null;
  };
  sb: SupabaseClient;
  now?: Date;
}): Promise<CampaignDirection> {
  const input = buildDirectionInput({
    campaignId: args.campaignId,
    roas: args.roas,
    breakEvenRoas: args.breakEvenRoas,
    status: args.status,
    alerts: args.alerts,
  });
  const result = recommendDirection(input);
  const suggestedBudgetCents = suggestBudgetCents(result.direction, args.currentBudgetCents, args.guardrails);
  const facts: ReasonFacts = {
    roas: args.roas,
    breakEvenRoas: args.breakEvenRoas,
    dataSufficient: result.dataSufficient,
    status: args.status,
  };

  const asOf = (args.now ?? new Date()).toISOString().slice(0, 10);

  // Cache read.
  const { data: cached } = await args.sb
    .from("campaign_direction_reason")
    .select("reason, source")
    .eq("shop_id", args.shopId)
    .eq("campaign_id", args.campaignId)
    .eq("as_of_date", asOf)
    .eq("direction", result.direction)
    .maybeSingle();
  if (cached?.reason) {
    return {
      direction: result.direction,
      actionKind: result.actionKind,
      suggestedBudgetCents,
      reason: String(cached.reason),
      reasonSource: cached.source === "claude" ? "claude" : "template",
      dataSufficient: result.dataSufficient,
    };
  }

  // Generate: Claude, else template.
  let reason: string;
  let reasonSource: "claude" | "template";
  try {
    reason = await directionReason(result.direction, facts);
    reasonSource = "claude";
  } catch (err) {
    console.error(`[direction] Claude phrasing failed for ${args.campaignId}; using template`, err);
    reason = directionTemplate(result.direction, facts);
    reasonSource = "template";
  }

  // Cache write (best-effort; a write failure must not fail the page — rule 12 logs it).
  const { error: upErr } = await args.sb.from("campaign_direction_reason").upsert({
    shop_id: args.shopId,
    campaign_id: args.campaignId,
    as_of_date: asOf,
    direction: result.direction,
    reason,
    source: reasonSource,
    model: reasonSource === "claude" ? assistantModel() : null,
  });
  if (upErr) console.error(`[direction] reason cache upsert failed for ${args.campaignId}`, upErr);

  return {
    direction: result.direction,
    actionKind: result.actionKind,
    suggestedBudgetCents,
    reason,
    reasonSource,
    dataSufficient: result.dataSufficient,
  };
}
