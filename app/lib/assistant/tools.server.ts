import type Anthropic from "@anthropic-ai/sdk";
import type { CalderynClient, CalderynError } from "../calderyn.server";
import type { DraftedAction } from "./types";
import { COMMERCE_TOOLS, COMMERCE_TOOL_NAMES, handleCommerceTool, type CommerceCtx } from "./commerce-tools.server";
import { ASSISTANT_ACTIONS, generatedWriteTools } from "./actions/registry.server";
import { runRegistryAction } from "./actions/execute.server";
import type { ActionReceipt, PendingActionCard } from "./actions/registry-types";

const COMMERCE_NAME_SET = new Set<string>(COMMERCE_TOOL_NAMES);
const REGISTRY_NAME_SET = new Set<string>(ASSISTANT_ACTIONS.map((a) => a.name));

export interface ToolDispatchResult {
  content: string; // JSON string handed back to the model as tool_result content
  isError?: boolean;
  draftedAction?: DraftedAction;
  receipt?: ActionReceipt;
  pending?: PendingActionCard;
}

const LIMIT_CAP = 200;

/** Read tools + flag_alert, shared by the in-app assistant and external buyer clients. */
const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_alerts",
    description:
      "List the shop's alerts (issues Calderyn detected), highest priority first. Use to find or filter alerts before explaining them. Returns shaped Alert objects; money fields are in cents.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "acknowledged", "resolved"] },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        detector_id: { type: "string", description: "Filter to one detector, e.g. campaign_below_breakeven" },
        limit: { type: "number", description: "Max rows (<=200, default 50)" },
      },
    },
  },
  {
    name: "get_alert",
    description:
      "Fetch one alert by id with its full evidence and narrative. Use when the merchant asks about a specific alert or before proposing an action on it.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_audit",
    description:
      "List recent actions taken (the audit log), newest first. Use to answer 'what changed' or 'what did we do about X'.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max rows (<=200, default 50)" } },
    },
  },
  {
    name: "list_campaigns",
    description:
      "List ad campaigns with spend, ROAS and margin. Use for questions about ad performance. Money fields are in cents.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["active", "paused"] } },
    },
  },
  {
    name: "list_skus",
    description:
      "List SKUs with on-hand units, days of cover and velocity. Use for inventory questions. Set low_cover_only to focus on at-risk stock.",
    input_schema: {
      type: "object",
      properties: { low_cover_only: { type: "boolean", description: "Only SKUs with < 14 days of cover" } },
    },
  },
  {
    name: "get_guardrails",
    description:
      "Get the shop's guardrail config (daily action budget, per-action cap, cooldown, business hours). Use to explain why an action might be blocked or limited.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_integrations",
    description:
      "Get connection status of Meta, Google and QuickBooks. Use to explain missing data (e.g. Meta not connected).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "flag_alert",
    description:
      "Flag (acknowledge) an alert, moving it out of the open queue immediately. This EXECUTES right away — call it only when the merchant explicitly asks to flag, acknowledge, or mark an alert as handled. It never touches campaigns, budgets, or inventory; use the dedicated action tools for those.",
    input_schema: {
      type: "object",
      properties: { alert_id: { type: "string" } },
      required: ["alert_id"],
    },
  },
];

/**
 * The in-app merchant assistant's full toolset: reads + flag_alert + every
 * registered store action (registry.server.ts). Confirm-tier actions are
 * flagged in their description; the tool loop still calls them the same way.
 */
export const ASSISTANT_TOOLS: Anthropic.Tool[] = [...READ_TOOLS, ...generatedWriteTools()];

/**
 * Toolset advertised to external connected buyer clients (the calderyn-mcp server).
 * Registry write actions are merchant-assistant-only — external callers never get
 * an actionCtx, so the dispatcher would refuse them anyway (ACTIONS_UNAVAILABLE);
 * they are kept off this list so the model never even sees them offered.
 */
export const EXTERNAL_TOOLS: Anthropic.Tool[] = [...READ_TOOLS, ...COMMERCE_TOOLS];

function ok(obj: unknown): ToolDispatchResult {
  return { content: JSON.stringify(obj) };
}

function toolError(code: string, message: string): ToolDispatchResult {
  return { content: JSON.stringify({ code, message }), isError: true };
}

export interface ToolDispatcherDeps {
  /**
   * Flips an open alert to acknowledged (the "flag" the merchant sees).
   * Resolves false when nothing changed (already acknowledged/resolved).
   * Surfaces that don't support flagging simply omit it.
   */
  flagAlert?: (alertId: string) => Promise<boolean>;
  /** Shop + OAuth client context required by commerce tool handlers. When present, commerce
   *  tools are available to this caller (frictionless — no scope string required). */
  commerceCtx?: CommerceCtx;
  /** Shop + conversation identity required to run registry actions. Only the
   *  in-app merchant assistant (turn.server.ts) sets this; external/MCP
   *  callers never do, so registry tool names come back ACTIONS_UNAVAILABLE. */
  actionCtx?: { shopId: string; conversationId: string };
}

export function makeToolDispatcher(client: CalderynClient, deps: ToolDispatcherDeps = {}) {
  return async function dispatch(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<ToolDispatchResult> {
    try {
      if (COMMERCE_NAME_SET.has(name)) {
        if (!deps.commerceCtx) {
          return toolError("COMMERCE_UNAVAILABLE", `${name} is only available to a connected commerce client`);
        }
        return await handleCommerceTool(name, input, deps.commerceCtx);
      }
      if (REGISTRY_NAME_SET.has(name)) {
        if (!deps.actionCtx) {
          return toolError("ACTIONS_UNAVAILABLE", `${name} is only available to the signed-in merchant assistant`);
        }
        const out = await runRegistryAction(name, input, {
          ...deps.actionCtx,
          idempotencyKey: `assistant:${deps.actionCtx.conversationId}:${toolUseId}`,
        });
        return { content: out.content, isError: out.isError, receipt: out.receipt, pending: out.pending };
      }
      switch (name) {
        case "list_alerts": {
          const alerts = await client.alerts.list({
            status: input.status as string | undefined,
            severity: input.severity as string | undefined,
            detector: input.detector_id as string | undefined,
          });
          const limit = Math.min(Number(input.limit ?? 50), LIMIT_CAP);
          return ok({ alerts: alerts.slice(0, limit) });
        }
        case "get_alert":
          return ok({ alert: await client.alerts.get(String(input.id)) });
        case "list_audit": {
          const entries = await client.audit.list();
          const limit = Math.min(Number(input.limit ?? 50), LIMIT_CAP);
          return ok({ entries: entries.slice(0, limit) });
        }
        case "list_campaigns": {
          let campaigns = await client.campaigns.list();
          if (input.status === "active" || input.status === "paused") {
            campaigns = campaigns.filter((c) => c.status === input.status);
          }
          return ok({ campaigns });
        }
        case "list_skus": {
          let skus = await client.skus.list();
          if (input.low_cover_only === true) skus = skus.filter((s) => s.days_of_cover < 14);
          return ok({ skus });
        }
        case "get_guardrails":
          return ok({ guardrails: await client.guardrails.get() });
        case "list_integrations":
          return ok({ integrations: await client.integrations.list() });
        case "flag_alert": {
          if (!deps.flagAlert) {
            return toolError("FLAG_UNAVAILABLE", "Flagging alerts is not available here.");
          }
          // Shop-scoped get(): a foreign or unknown id throws ALERT_NOT_FOUND
          // before any write happens.
          const alert = await client.alerts.get(String(input.alert_id ?? ""));
          const flagged = await deps.flagAlert(alert.id);
          if (!flagged) {
            return toolError(
              "FLAG_FAILED",
              `Alert ${alert.id} was not flagged — it may already be acknowledged or resolved.`,
            );
          }
          return ok({
            ok: true,
            flagged: { id: alert.id, title: alert.title, status: "acknowledged" },
          });
        }
        default:
          return toolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
      }
    } catch (err) {
      const e = err as CalderynError;
      return toolError(e.code ?? "ERROR", e.message ?? String(err));
    }
  };
}
