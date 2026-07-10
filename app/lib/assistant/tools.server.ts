import type Anthropic from "@anthropic-ai/sdk";
import type { CalderynClient, CalderynError } from "../calderyn.server";
import type { Alert } from "../types";
import { DETECTOR_TO_ACTIONS } from "../labels";
import type { DraftedAction } from "./types";
import { COMMERCE_TOOLS, COMMERCE_TOOL_NAMES, handleCommerceTool, type CommerceCtx } from "./commerce-tools.server";
import { ASSISTANT_ACTIONS, generatedWriteTools } from "./actions/registry.server";
import { runRegistryAction } from "./actions/execute.server";
import type { ActionCtx, ActionReceipt, PendingActionCard } from "./actions/registry-types";
import { listOrdersUnified } from "../order/unified-list.server";
import { loadOrderDetail } from "../order/detail.server";
import { FULFILLMENT_STATUSES, SOURCES } from "../order/list-vocab";
import type { OrdersListParams, UnifiedOrderRow } from "../order/unified-list-types";
import { fulfillmentBadge, isStuckUnfulfilled } from "~/components/dashboard/screens/order-status";
import { formatMoney } from "~/lib/storefront/money";

const COMMERCE_NAME_SET = new Set<string>(COMMERCE_TOOL_NAMES);
const REGISTRY_NAME_SET = new Set<string>(ASSISTANT_ACTIONS.map((a) => a.name));
const ORDER_TOOL_NAMES = new Set<string>(["search_orders", "get_order"]);

export interface ToolDispatchResult {
  content: string; // JSON string handed back to the model as tool_result content
  isError?: boolean;
  draftedAction?: DraftedAction;
  receipt?: ActionReceipt;
  pending?: PendingActionCard;
}

const LIMIT_CAP = 200;

/**
 * Read tools + flag_alert, shared by the in-app assistant and external buyer
 * clients. Also what turn.server.ts advertises to callers that don't set
 * allowActions (e.g. the legacy embedded surface) — the model never sees a
 * write tool name it can't actually dispatch.
 */
export const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_alerts",
    description:
      "List the shop's alerts (issues Calderyn detected), highest priority first. Use to find or filter alerts before explaining them. Returns shaped Alert objects; money fields are in cents. Each alert carries allowed_actions — the action kinds runnable against THAT alert.",
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
      "Fetch one alert by id with its full evidence and narrative. Use when the merchant asks about a specific alert or before proposing an action on it. The returned alert carries allowed_actions — the action kinds runnable against THAT alert.",
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
 * Order search/detail (Phase 4 Task 5) — deliberately NOT part of READ_TOOLS. READ_TOOLS is
 * shared with EXTERNAL_TOOLS (external connected buyer clients on the calderyn-mcp seam, see
 * commerce-tools.server.ts) and the legacy embedded surface's no-allowActions call; either of
 * those handing a random buyer/shopper's AI client a tool that lists or reads ANY order in the
 * shop — even with the customer email masked — would leak other buyers' purchase history and
 * order totals. These two tools are merchant-assistant-only: the dispatcher below refuses them
 * without an actionCtx, the same gate registry (write) actions use, and dashboard.api.assistant.tsx
 * is the only caller that ever sets allowActions (and therefore actionCtx) today.
 */
export const ORDER_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_orders",
    description:
      "Search this shop's orders (native + imported). Use this FIRST to find the right order_id, then call get_order for full detail — never guess an order_id. Returns compact rows with a masked customer email; total_count reports how many matched beyond what's shown (e.g. 'showing 10 of 88').",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Free-text match (order ref, customer, etc.)" },
        payment_status: { type: "string", description: "e.g. paid, refunded, partially_refunded" },
        fulfillment_status: { type: "string", enum: [...FULFILLMENT_STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        limit: { type: "number", description: "Max rows (<=20, default 10)" },
      },
    },
  },
  {
    name: "get_order",
    description:
      "Fetch one order's full detail by id — pass the id exactly as returned by search_orders (imported orders carry a `shopify:`-prefixed id). Returns totals, line items, the 5 most recent timeline events, buyer-history signals, and any returns. Customer email is masked.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
];

/**
 * The in-app merchant assistant's full toolset: reads + flag_alert + order search/detail + every
 * registered store action (registry.server.ts). Confirm-tier actions are flagged in their
 * description; the tool loop still calls them the same way.
 */
export const ASSISTANT_TOOLS: Anthropic.Tool[] = [...READ_TOOLS, ...ORDER_TOOLS, ...generatedWriteTools()];

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

/**
 * Enriches an alert with the action kinds actually runnable against it, so the
 * model never offers an action it can't execute (e.g. create_po_draft on a
 * campaign-spend alert). Unknown detectors fall back to snooze-only, matching
 * recommendedAction()'s fallback in labels.ts.
 */
function withAllowedActions<T extends Pick<Alert, "detector_id">>(
  alert: T,
): T & { allowed_actions: string[] } {
  return {
    ...alert,
    allowed_actions: DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"],
  };
}

function toolError(code: string, message: string): ToolDispatchResult {
  return { content: JSON.stringify({ code, message }), isError: true };
}

const ORDER_SEARCH_DEFAULT_LIMIT = 10;
const ORDER_SEARCH_LIMIT_CAP = 20;
const ORDER_TIMELINE_CAP = 5;
const ORDER_LINES_CAP = 20;

/** "m***@domain.com" — first character, a fixed mask, then the full domain, so the model can
 *  recognize repeat customers across a search without ever seeing a usable email address. A
 *  missing/empty email returns null; an unparseable one (no '@') falls back to first-char+mask
 *  rather than guessing a domain. */
function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return `${email.charAt(0)}***`;
  return `${email.charAt(0)}***${email.slice(at)}`;
}

/** `orders/<sourceId>` form for a unified-list row — `shopify:`-prefixed for a migrated order,
 *  mirroring Orders.tsx's private displayOrderSourceId (duplicated rather than exported, the same
 *  reasoning the order read models already use for their own small private helpers). */
function orderSourceId(row: UnifiedOrderRow): string {
  return row.source === "shopify" ? `shopify:${row.id}` : row.id;
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
   *  in-app merchant assistant (turn.server.ts) sets this, and only when the
   *  caller opted into allowActions; external/MCP callers and the legacy
   *  embedded surface never do, so registry tool names come back
   *  ACTIONS_UNAVAILABLE. idempotencyKey is minted per tool_use inside the
   *  dispatcher, not supplied by callers. */
  actionCtx?: Omit<ActionCtx, "idempotencyKey">;
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
      if (ORDER_TOOL_NAMES.has(name)) {
        if (!deps.actionCtx) {
          return toolError("ORDERS_UNAVAILABLE", `${name} is only available to the signed-in merchant assistant`);
        }
        const shopId = deps.actionCtx.shopId;
        if (name === "search_orders") {
          const rawLimit = Number(input.limit ?? ORDER_SEARCH_DEFAULT_LIMIT);
          const limit = Math.min(
            Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : ORDER_SEARCH_DEFAULT_LIMIT, 1),
            ORDER_SEARCH_LIMIT_CAP,
          );
          const params: OrdersListParams = { limit };
          if (typeof input.search === "string" && input.search.trim()) params.search = input.search.trim();
          if (typeof input.payment_status === "string" && input.payment_status.trim()) {
            params.paymentStatus = [input.payment_status.trim()];
          }
          if (typeof input.fulfillment_status === "string" && FULFILLMENT_STATUSES.has(input.fulfillment_status)) {
            params.fulfillmentStatus = input.fulfillment_status as OrdersListParams["fulfillmentStatus"];
          }
          if (typeof input.source === "string" && SOURCES.has(input.source)) {
            params.source = input.source as OrdersListParams["source"];
          }
          const page = await listOrdersUnified(shopId, params);
          const now = Date.now();
          const orders = page.rows.map((row) => ({
            ref: row.ref,
            id: orderSourceId(row),
            source: row.source,
            customer: maskEmail(row.buyerEmail),
            total: formatMoney(row.totalCents, row.currency),
            payment_status: row.paymentStatus,
            fulfillment_status:
              row.source === "calderyn" ? (fulfillmentBadge(row.state, row.cancelledAt)?.label ?? null) : null,
            date: row.occurredAt,
            stuck: row.source === "calderyn" ? isStuckUnfulfilled(row.state, row.occurredAt, now) : false,
          }));
          return ok({ orders, total_count: page.totalCount });
        }
        // get_order
        const orderId = typeof input.order_id === "string" ? input.order_id.trim() : "";
        if (!orderId) return toolError("INVALID_INPUT", "order_id is required");
        const detail = await loadOrderDetail(shopId, orderId);
        if (!detail) return toolError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
        const lines = detail.lines.slice(0, ORDER_LINES_CAP).map((l) => ({
          title: l.title,
          quantity: l.quantity + l.reducedQuantity,
          effective_quantity: l.quantity,
          fulfilled: l.fulfilledQuantity,
        }));
        const latestTimeline = detail.timeline
          .slice(0, ORDER_TIMELINE_CAP)
          .map((e) => ({ title: e.title, at: e.at }));
        const returns = detail.returns.map((r) => ({
          status: r.status,
          refund_cents: r.lines.reduce((sum, line) => sum + line.refundCents, 0),
        }));
        return ok({
          order: {
            ref: detail.ref,
            source: detail.source,
            state: detail.state,
            payment_status: detail.financialStatus,
            created: detail.createdAt,
            totals: {
              subtotal: formatMoney(detail.subtotalCents, detail.currency),
              shipping: formatMoney(detail.shippingCents, detail.currency),
              tax: formatMoney(detail.taxCents, detail.currency),
              total: formatMoney(detail.totalCents, detail.currency),
              refunded: formatMoney(detail.refundedCents, detail.currency),
            },
            customer: maskEmail(detail.buyer?.email),
            lines,
            latest_timeline: latestTimeline,
            signals: detail.signals,
            returns,
            tags: detail.tags,
          },
        });
      }
      switch (name) {
        case "list_alerts": {
          const alerts = await client.alerts.list({
            status: input.status as string | undefined,
            severity: input.severity as string | undefined,
            detector: input.detector_id as string | undefined,
          });
          const limit = Math.min(Number(input.limit ?? 50), LIMIT_CAP);
          return ok({ alerts: alerts.slice(0, limit).map(withAllowedActions) });
        }
        case "get_alert":
          return ok({ alert: withAllowedActions(await client.alerts.get(String(input.id))) });
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
