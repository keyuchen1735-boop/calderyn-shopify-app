import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { refundOrder, type OrderRow } from "~/lib/dashboard/orders-client";

// Issue a Stripe refund on an owned order (#3b). Full by default; a merchant can enter a
// smaller partial amount. The idempotency key is minted once per open so a double-submit
// (or a retry after a network blip) can never double-refund. A Stripe refund is irreversible,
// so the confirm copy says so — there is no undo.
export default function RefundModal({
  app,
  order,
  onClose,
  onDone,
}: {
  app: DashboardCtx;
  order: OrderRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [full, setFull] = useState(true);
  const [dollars, setDollars] = useState("");
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(false);
  const [busy, setBusy] = useState(false);
  // One stable key per refund intent (survives re-renders); reused on retry so Stripe dedups.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drive every figure off what is ACTUALLY refundable (captured − already-refunded), not the gross
  // order total — otherwise a partially-refunded order advertises more than the server will allow
  // and a partial between the true remaining and the gross total client-passes but 422s server-side.
  const refundableCents = order.remainingRefundableCents;
  const partialCents = Math.round(Number(dollars) * 100);
  const invalidPartial = !full && (!Number.isFinite(partialCents) || partialCents <= 0 || partialCents > refundableCents);

  const submit = async () => {
    if (invalidPartial) {
      app.toast(`Enter a partial amount between $0 and ${money(refundableCents, order.currency)}.`, "warn");
      return;
    }
    setBusy(true);
    try {
      const res = await refundOrder(order.id, {
        amountCents: full ? undefined : partialCents,
        idempotencyKey,
        reason: reason.trim() || undefined,
        restock: full ? restock : undefined,
      });
      app.toast(
        `Refunded ${money(res.amountCents, order.currency)}. Order is now ${res.orderState.replace("_", " ")}.${res.restockedLines > 0 ? " Items restocked." : ""}`,
        "check",
      );
      if (res.restockError) {
        app.toast("Refund issued, but some items could not be restocked. Check your inventory.", "warn");
      }
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Refund failed.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "color-mix(in oklch, black 32%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Issue refund"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Refund {order.ref}</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            {refundableCents < order.totalCents
              ? `Order total ${money(order.totalCents, order.currency)} · ${money(refundableCents, order.currency)} still refundable. `
              : `Order total ${money(order.totalCents, order.currency)}. `}
            A refund is sent back through Stripe and cannot be undone.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>Amount</span>
              <select
                className="cd-input"
                value={full ? "full" : "partial"}
                onChange={(e) => setFull(e.target.value === "full")}
              >
                <option value="full">Full refund ({money(refundableCents, order.currency)})</option>
                <option value="partial">Partial refund</option>
              </select>
            </label>
            {!full && (
              <label className="cd-field">
                <span>Partial amount (USD)</span>
                <input
                  className="cd-input tabular-nums"
                  type="number"
                  min={0}
                  step="0.01"
                  value={dollars}
                  onChange={(e) => setDollars(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            )}
            <label className="cd-field">
              <span>Reason (optional)</span>
              <input
                className="cd-input"
                type="text"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Damaged in transit"
              />
            </label>
            {full && (
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                <span className="cd-caption">Restock all items at your primary location</span>
              </label>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" icon="rotate" onClick={submit} disabled={busy || invalidPartial}>
                {busy ? "Refunding…" : "Issue refund"}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
