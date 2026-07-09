// POST { pending_id, decision } → execute or dismiss a Tier-2 assistant action.
// The client sends ONLY the id; the action name and parameters come from the
// server-side pending row (claimPendingAction), so a tampered request cannot
// change what runs. Claim is single-use and atomic.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, jsonOk, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  claimPendingAction,
  dismissPendingAction,
  markPendingExecuted,
} from "~/lib/assistant/actions/pending.server";
import { runClaimedAction } from "~/lib/assistant/actions/execute.server";
import { appendMessage } from "~/lib/assistant/conversations.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  if (!(await rateLimit(`assistant-confirm:${session.shopId}`, 20, 60_000))) {
    return jsonError(429, "rate_limited");
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const pendingId = typeof body.pending_id === "string" ? body.pending_id : "";
  const decision = body.decision === "dismiss" ? "dismiss" : body.decision === "confirm" ? "confirm" : null;
  if (!pendingId || !decision) return jsonError(422, "invalid_body", "pending_id and decision are required.");

  if (decision === "dismiss") {
    return dashboardJson(async () => ({ dismissed: await dismissPendingAction(session.shopId, pendingId) }));
  }

  const claimed = await claimPendingAction(session.shopId, pendingId);
  if ("error" in claimed) {
    const why =
      claimed.error === "expired"
        ? "This confirmation expired. Ask the assistant again."
        : claimed.error === "already_used"
          ? "This action was already confirmed or dismissed."
          : "Confirmation not found.";
    return jsonError(409, "pending_unavailable", why);
  }

  return dashboardJson(async () => {
    let receipt;
    try {
      receipt = await runClaimedAction(claimed.action, claimed.input, {
        shopId: session.shopId,
        conversationId: claimed.conversationId,
        idempotencyKey: `assistant-confirm:${pendingId}`,
      });
    } catch (err) {
      // Execution failed after claim was consumed (single-use; the merchant
      // re-asks the assistant, which re-proposes). Surface the real reason as
      // 502 (not 500 opaque internal_error) so merchants see why refunds/budget
      // changes rejected.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[assistant.confirm] action execution failed", { pendingId, action: claimed.action }, err);
      throw jsonOk(
        { error: "action_failed", message, receipt: null },
        { status: 502 },
      );
    }

    // Bookkeeping: mark the pending action as executed. Failure here must never
    // hide the fact that the action succeeded, so it is logged and swallowed.
    try {
      await markPendingExecuted(session.shopId, pendingId, receipt.auditId);
    } catch (err) {
      console.error("[assistant.confirm] failed to mark pending executed", { pendingId }, err);
    }

    // Best-effort: persist the outcome into the conversation thread so a page
    // reload and the model's next turn both see it happened. The action has
    // already executed at this point — a failure here must never turn into a
    // failure response (that would misreport a real action as failed), so it
    // is logged and swallowed rather than rethrown.
    let message = null;
    try {
      message = await appendMessage(session.shopId, claimed.conversationId, {
        role: "assistant",
        content: `Confirmed — ${receipt.summary}`,
        receipts: [receipt],
        pendingAction: null,
      });
    } catch (err) {
      console.error("[assistant.confirm] failed to persist confirmation message", err);
    }

    return { receipt, message };
  });
}
