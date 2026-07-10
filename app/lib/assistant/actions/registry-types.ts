// app/lib/assistant/actions/registry-types.ts
// Shared shapes for the assistant action registry. Pure types — safe to
// import from client code (ChatMessage embeds ActionReceipt/PendingActionCard).
import type Anthropic from "@anthropic-ai/sdk";

export type RiskTier = "execute" | "confirm";

export interface ActionCtx {
  /** shops.id — always from the dashboard session, never model input. */
  shopId: string;
  conversationId: string;
  /** Minted per tool_use so a retried loop step cannot double-fire. */
  idempotencyKey: string;
}

export interface ActionReceipt {
  action: string;
  /** Past-tense human line, e.g. 'Paused "Summer Sale"'. */
  summary: string;
  /** action_audit row id when the executor wrote one; enables the Undo chip. */
  auditId: string | null;
  undoable: boolean;
  /** Extra structured fields echoed to the model (e.g. prior_price_cents). */
  detail?: Record<string, unknown>;
}

export interface PendingActionCard {
  id: string;
  action: string;
  summary: string;
  expiresAt: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export interface AssistantAction {
  name: string;
  /** Written for the model: when to use it, units (cents), preconditions. */
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  tier: RiskTier;
  /** Whether a succeeded run is undoable via the audit undo route. */
  undoable: boolean;
  validate(input: Record<string, unknown>): ValidationResult;
  /** Tier-2 only: the human line on the confirm card. Validated input. */
  confirmSummary?(ctx: ActionCtx, input: Record<string, unknown>): Promise<string>;
  run(ctx: ActionCtx, input: Record<string, unknown>): Promise<ActionReceipt>;
}
