// Pure validation for EditBudgetModal's dollar-input field. Framework-free,
// same pattern as reduce-line-preview.ts / transfer-modal-state.ts — kept
// separate so the parsing/threshold rules are unit-tested without rendering
// the modal.

/** Above this, the modal shows a non-blocking "double check" hint — the
 *  server has no ceiling on manual budgets, so this is UI-only guardrail,
 *  never a block. */
export const HIGH_BUDGET_CENTS = 100_000;

export interface BudgetValidation {
  /** Parsed cents; NaN-safe (Number.isFinite guards downstream use). */
  cents: number;
  /** A positive, finite amount was entered. */
  valid: boolean;
  /** Valid AND different from the campaign's current budget — gates the
   *  Save button so a no-op click can't look unresponsive. */
  changed: boolean;
  /** Valid and above HIGH_BUDGET_CENTS. */
  high: boolean;
}

export function budgetValidation(dollars: string, currentCents: number): BudgetValidation {
  const cents = Math.round(Number(dollars) * 100);
  const valid = Number.isFinite(cents) && cents > 0;
  return {
    cents,
    valid,
    changed: valid && cents !== currentCents,
    high: valid && cents > HIGH_BUDGET_CENTS,
  };
}
