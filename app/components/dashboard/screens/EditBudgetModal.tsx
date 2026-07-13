import { useState } from "react";
import { Btn, Card } from "../ui";
import { money } from "../format";
import { useModalChrome } from "../use-modal-chrome";
import { executeCampaignAction, DashboardApiError } from "~/lib/dashboard/client";
import { budgetValidation } from "./edit-budget-preview";
import type { DashboardCtx } from "../context";
import type { CampaignVM } from "../view-models";

/** Set a campaign's daily budget to an exact value. Meta-only (the only
 *  platform with a budget write path); callers hide the entry point otherwise. */
export function EditBudgetModal({
  app,
  c,
  onClose,
  onSaved,
}: {
  app: DashboardCtx;
  c: CampaignVM;
  onClose: () => void;
  onSaved: (newCents: number) => void;
}) {
  const [dollars, setDollars] = useState(
    c.daily_budget_cents > 0 ? (c.daily_budget_cents / 100).toFixed(2) : "",
  );
  const [busy, setBusy] = useState(false);
  const chrome = useModalChrome<HTMLDivElement>({ onClose });
  const { cents, valid, changed, high } = budgetValidation(dollars, c.daily_budget_cents);

  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, { type: "update_campaign_budget", dailyBudgetCents: cents });
      app.toast("Budget updated.", "check", "success");
      onSaved(cents);
      // The server mirrors the budget before responding, so the refreshed
      // campaigns data supersedes (and clears) the local patch onSaved wrote.
      app.refresh();
      onClose();
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't update the budget — try again.";
      app.toast(message, "x", "critical");
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 90,
        background: "color-mix(in oklch, black 32%, transparent)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={chrome.ref}
        role="dialog"
        aria-modal="true"
        aria-label="Edit daily budget"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={chrome.onKeyDown}
        style={{ width: "100%", maxWidth: 340 }}
      >
        <Card>
          <div className="cd-row-title" style={{ marginBottom: 4 }}>Daily budget</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>{c.name}</div>
          <input
            className="cd-input"
            inputMode="decimal"
            placeholder="e.g. 25"
            aria-label="Daily budget in dollars"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
          />
          {valid && (
            <div className="cd-caption" style={{ marginTop: 8 }}>
              About {money(cents * 30)} per month at this rate.
            </div>
          )}
          {high && (
            <div className="cd-caption" style={{ marginTop: 8, color: "var(--orange)" }}>
              {"That's a big budget — double-check before saving."}
            </div>
          )}
          <div className="flex items-center" style={{ gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
            <Btn small onClick={onClose}>Cancel</Btn>
            <Btn small kind="primary" disabled={!changed || busy} onClick={save}>
              {busy ? "Saving…" : "Save budget"}
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}
