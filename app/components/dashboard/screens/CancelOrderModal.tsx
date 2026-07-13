import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cancelOrder, type OrderDetail } from "~/lib/dashboard/orders-client";
import { useModalEntrance } from "./order-modal-motion";

// Abandon an order before or during fulfillment. When the order captured money, the merchant
// chooses whether to refund it (and whether to restock) in the same step — mirrors the server's
// cancel executor, which folds a requested refund into the same cancellation rather than treating
// them as two separate actions. Irreversible, so the copy says so plainly.
export default function CancelOrderModal({
  app,
  order,
  onClose,
  onDone,
}: {
  app: DashboardCtx;
  order: OrderDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  // checkout_pending orders never captured anything — the read model falls back to the gross
  // total for remainingRefundableCents on that state, so gate on state too or the modal claims
  // money was captured (and defaults to refunding) on an order that never charged the customer.
  const hasMoneyToRefund = order.remainingRefundableCents > 0 && order.state !== "checkout_pending";
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState(true);
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const { overlayRef, dialogRef } = useModalEntrance();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await cancelOrder(order.id, {
        reason: reason.trim() || undefined,
        refund: hasMoneyToRefund && refund,
        restock: hasMoneyToRefund ? restock : false,
        idempotencyKey,
      });
      app.toast(
        `Order cancelled.${res.refunded ? " Refunded." : ""}${res.restockedLines > 0 ? ` ${res.restockedLines} item(s) restocked.` : ""}`,
        "check",
      );
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't cancel this order.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={overlayRef} className="cd-modal-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cancel order"
        onClick={(e) => e.stopPropagation()}
        className="cd-modal-dialog"
        style={{ maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Cancel {order.ref}</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            {hasMoneyToRefund
              ? `${money(order.remainingRefundableCents, order.currency)} was captured on this order. `
              : ""}
            Cancelling can&apos;t be undone.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>Reason (optional)</span>
              <input
                className="cd-input"
                type="text"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Customer requested cancellation"
              />
            </label>
            {hasMoneyToRefund && (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
                  <span className="cd-caption">Refund the customer in full</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                  <span className="cd-caption">Restock items</span>
                </label>
              </>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Keep order</Btn>
              <Btn kind="danger" icon="ban" onClick={submit} disabled={busy}>
                {busy ? "Cancelling…" : "Cancel order"}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
