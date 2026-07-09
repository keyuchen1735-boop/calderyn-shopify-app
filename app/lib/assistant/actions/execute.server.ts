// Shared run path for every registry action: validate → tier gate → execute
// or park for confirmation → structured outcome for the tool loop.
import type { ActionCtx, ActionReceipt, AssistantAction, PendingActionCard } from "./registry-types";
import { actionByName } from "./registry.server";
import { createPendingAction } from "./pending.server";

export interface ActionRunOutcome {
  content: string;
  isError?: boolean;
  receipt?: ActionReceipt;
  pending?: PendingActionCard;
}

let actions: AssistantAction[] | null = null;
/** Test seam: swap the catalog without touching the real domain modules. */
export function __setActionsForTest(list: AssistantAction[]): void {
  actions = list;
}
function lookup(name: string): AssistantAction | undefined {
  return actions ? actions.find((a) => a.name === name) : actionByName(name);
}

export async function runRegistryAction(
  name: string,
  rawInput: Record<string, unknown>,
  ctx: ActionCtx,
): Promise<ActionRunOutcome> {
  const action = lookup(name);
  if (!action) {
    return { content: JSON.stringify({ code: "UNKNOWN_ACTION", message: `Unknown action: ${name}` }), isError: true };
  }
  const validated = action.validate(rawInput);
  if (!validated.ok) {
    return { content: JSON.stringify({ code: "INVALID_INPUT", message: validated.message }), isError: true };
  }
  if (action.tier === "confirm") {
    const summary = action.confirmSummary
      ? await action.confirmSummary(ctx, validated.value)
      : action.description;
    const pending = await createPendingAction(ctx.shopId, ctx.conversationId, action.name, validated.value, summary);
    return {
      content: JSON.stringify({
        status: "pending_merchant_confirmation",
        summary,
        note: "The merchant sees a confirm card. Do not claim the action happened; say it is ready and awaiting their confirmation.",
      }),
      pending,
    };
  }
  return execute(action, ctx, validated.value);
}

/** Confirm-route path: the merchant already confirmed, so the tier gate is skipped. */
export async function runClaimedAction(
  name: string,
  input: Record<string, unknown>,
  ctx: ActionCtx,
): Promise<ActionReceipt> {
  const action = lookup(name);
  if (!action) throw new Error(`Unknown action: ${name}`);
  const out = await execute(action, ctx, input);
  if (out.isError || !out.receipt) throw new Error(JSON.parse(out.content).message ?? "Action failed");
  return out.receipt;
}

async function execute(
  action: AssistantAction,
  ctx: ActionCtx,
  input: Record<string, unknown>,
): Promise<ActionRunOutcome> {
  try {
    const receipt = await action.run(ctx, input);
    return { content: JSON.stringify({ ok: true, receipt }), receipt };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // Surface the upstream error payload verbatim (repo rule: never swallow).
    return {
      content: JSON.stringify({ code: e.code ?? "ACTION_FAILED", message: e.message ?? String(err) }),
      isError: true,
    };
  }
}
