// Campaign capabilities — every entry funnels into the SAME audited executor
// pipeline the Campaigns screen uses (idempotency, ownership check, audit row,
// undo window). Money is cents throughout.
import { executeAction, type ExecutableKind } from "../../actions/execute.server";
import { executeReallocation } from "../../actions/reallocate.server";
import { createCampaignDraft } from "../../ads/campaign-draft.server";
import type { CampaignDraftPlatform } from "../../ads/campaign-draft-types";
import { isValidRegion, type RegionCode } from "../../ads/actions";
import { getSupabase } from "../../supabase.server";
import type { ActionCtx, ActionReceipt, AssistantAction, ValidationResult } from "./registry-types";

const ACTOR = "merchant:assistant";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function runExecutable(
  kind: ExecutableKind,
  ctx: ActionCtx,
  campaignId: string,
  summary: string,
  undoable: boolean,
  extra: { dailyBudgetCents?: number; region?: RegionCode } = {},
): Promise<ActionReceipt> {
  const result = await executeAction(
    ctx.shopId,
    { alertId: null, kind, campaignId, idempotencyKey: ctx.idempotencyKey, actor: ACTOR, ...extra },
    getSupabase(),
  );
  if (result.outcome !== "succeeded") {
    throw new Error(
      result.outcome === "failed"
        ? `The ad platform rejected this action (audit ${result.id}). Check the action history for the provider error.`
        : `The platform is temporarily unavailable; the action is queued for retry (audit ${result.id}).`,
    );
  }
  return { action: kind, summary, auditId: result.id, undoable };
}

function campaignIdInput(i: Record<string, unknown>): ValidationResult {
  const id = str(i.campaign_id);
  return id ? { ok: true, value: { campaign_id: id } } : { ok: false, message: "campaign_id (uuid from list_campaigns) is required" };
}

export const CAMPAIGN_ACTIONS: AssistantAction[] = [
  {
    name: "pause_campaign",
    description: "Pause a live ad campaign. Undoable for 24h. campaign_id is the uuid from list_campaigns.",
    inputSchema: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
    tier: "execute",
    undoable: true,
    validate: campaignIdInput,
    run: (ctx, i) => runExecutable("pause_campaign", ctx, String(i.campaign_id), "Paused the campaign", true),
  },
  {
    name: "resume_campaign",
    description: "Resume (unpause) an ad campaign. Undoable. campaign_id from list_campaigns.",
    inputSchema: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
    tier: "execute",
    undoable: true,
    validate: campaignIdInput,
    run: (ctx, i) => runExecutable("resume_campaign", ctx, String(i.campaign_id), "Resumed the campaign", true),
  },
  {
    name: "reduce_campaign_budget",
    description: "Lower a campaign's daily budget to daily_budget_cents (the NEW total, in cents, > 0). Undoable.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" }, daily_budget_cents: { type: "number" } },
      required: ["campaign_id", "daily_budget_cents"],
    },
    tier: "execute",
    undoable: true,
    validate: (i) => {
      const id = str(i.campaign_id);
      const cents = posInt(i.daily_budget_cents);
      if (!id) return { ok: false, message: "campaign_id is required" };
      if (!cents) return { ok: false, message: "daily_budget_cents must be a positive integer (cents)" };
      return { ok: true, value: { campaign_id: id, daily_budget_cents: cents } };
    },
    run: (ctx, i) =>
      runExecutable("reduce_campaign_budget", ctx, String(i.campaign_id),
        `Reduced the daily budget to $${(Number(i.daily_budget_cents) / 100).toFixed(2)}`, true,
        { dailyBudgetCents: Number(i.daily_budget_cents) }),
  },
  {
    name: "increase_campaign_budget",
    description: "Raise a campaign's daily budget to daily_budget_cents (the NEW total, in cents). Spends more money and is NOT undoable.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" }, daily_budget_cents: { type: "number" } },
      required: ["campaign_id", "daily_budget_cents"],
    },
    tier: "confirm",
    undoable: false,
    validate: (i) => {
      const id = str(i.campaign_id);
      const cents = posInt(i.daily_budget_cents);
      if (!id) return { ok: false, message: "campaign_id is required" };
      if (!cents) return { ok: false, message: "daily_budget_cents must be a positive integer (cents)" };
      return { ok: true, value: { campaign_id: id, daily_budget_cents: cents } };
    },
    confirmSummary: async (_ctx, i) =>
      `Raise the campaign's daily budget to $${(Number(i.daily_budget_cents) / 100).toFixed(2)} — spends more and can't be auto-undone`,
    run: (ctx, i) =>
      runExecutable("increase_campaign_budget", ctx, String(i.campaign_id),
        `Raised the daily budget to $${(Number(i.daily_budget_cents) / 100).toFixed(2)}`, false,
        { dailyBudgetCents: Number(i.daily_budget_cents) }),
  },
  {
    name: "exclude_geo",
    description: "Exclude a geographic region bucket from a campaign's targeting. Undoable. region must be a bucket seen in alert evidence (e.g. us_midwest).",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" }, region: { type: "string" } },
      required: ["campaign_id", "region"],
    },
    tier: "execute",
    undoable: true,
    validate: (i) => {
      const id = str(i.campaign_id);
      if (!id) return { ok: false, message: "campaign_id is required" };
      if (!isValidRegion(i.region as RegionCode)) return { ok: false, message: `region "${String(i.region)}" is not a known region bucket` };
      return { ok: true, value: { campaign_id: id, region: i.region as RegionCode } };
    },
    run: (ctx, i) =>
      runExecutable("exclude_geo", ctx, String(i.campaign_id), `Excluded ${String(i.region)} from targeting`, true,
        { region: i.region as RegionCode }),
  },
  {
    name: "reallocate_budget",
    description: "Move daily budget between two campaigns: amount_cents moves from source_campaign_id to dest_campaign_id. Undoable (both sides restored).",
    inputSchema: {
      type: "object",
      properties: {
        source_campaign_id: { type: "string" },
        dest_campaign_id: { type: "string" },
        amount_cents: { type: "number" },
      },
      required: ["source_campaign_id", "dest_campaign_id", "amount_cents"],
    },
    tier: "execute",
    undoable: true,
    validate: (i) => {
      const src = str(i.source_campaign_id);
      const dst = str(i.dest_campaign_id);
      const cents = posInt(i.amount_cents);
      if (!src || !dst) return { ok: false, message: "source_campaign_id and dest_campaign_id are required" };
      if (src === dst) return { ok: false, message: "source and dest must be different campaigns" };
      if (!cents) return { ok: false, message: "amount_cents must be a positive integer (cents)" };
      return { ok: true, value: { source_campaign_id: src, dest_campaign_id: dst, amount_cents: cents } };
    },
    run: async (ctx, i) => {
      const result = await executeReallocation(
        ctx.shopId,
        {
          alertId: null,
          sourceCampaignId: String(i.source_campaign_id),
          destCampaignId: String(i.dest_campaign_id),
          amountCents: Number(i.amount_cents),
          idempotencyKey: ctx.idempotencyKey,
          actor: ACTOR,
        },
        getSupabase(),
      );
      if (result.outcome !== "succeeded") {
        throw new Error(`Reallocation did not complete (audit ${result.id}, outcome ${result.outcome}).`);
      }
      return {
        action: "reallocate_budget",
        summary: `Moved $${(Number(i.amount_cents) / 100).toFixed(2)}/day between campaigns`,
        auditId: result.id,
        undoable: true,
      };
    },
  },
  {
    name: "create_campaign_draft",
    description: "Create a named ad-campaign draft (no live spend) on a platform: google, meta, or tiktok.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, platform: { type: "string", enum: ["google", "meta", "tiktok"] } },
      required: ["name", "platform"],
    },
    tier: "execute",
    undoable: false,
    validate: (i) => {
      const name = str(i.name);
      const platform = str(i.platform);
      if (!name || name.length > 120) return { ok: false, message: "name is required (max 120 chars)" };
      if (!platform || !["google", "meta", "tiktok"].includes(platform)) {
        return { ok: false, message: "platform must be google, meta, or tiktok" };
      }
      return { ok: true, value: { name, platform } };
    },
    run: async (ctx, i) => {
      const draft = await createCampaignDraft(ctx.shopId, {
        name: String(i.name),
        platform: String(i.platform) as CampaignDraftPlatform,
      });
      return {
        action: "create_campaign_draft",
        summary: `Created a ${String(i.platform)} campaign draft "${String(i.name)}"`,
        auditId: null,
        undoable: false,
        detail: { draft_id: draft.id },
      };
    },
  },
];
