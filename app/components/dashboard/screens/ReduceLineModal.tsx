import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { reduceOrderLine, type OrderDetail, type OrderDetailLine } from "~/lib/dashboard/orders-client";
import { reduceLineRefundPreview } from "./reduce-line-preview";

// Reduce a single paid-order line's quantity, refunding the delta (unit price + a proportional
// share of the order's captured tax) and optionally restocking it. Mirrors RefundModal/
// CancelOrderModal's overlay idiom and idempotency-key-per-open pattern. The new-quantity floor is
// the line's fulfilled quantity — already-shipped units can never be reduced away — and the
// ceiling is one below the line's current effective quantity (a "reduction" of 0 is refused
// server-side as nothing_to_reduce).
export default function ReduceLineModal({
  app,
  order,
  line,
  onClose,
  onDone,
}: {
  app: DashboardCtx;
  order: OrderDetail;
  line: OrderDetailLine;
  onClose: () => void;
  onDone: () => void;
}) {
  const min = line.fulfilledQuantity;
  const max = Math.max(min, line.quantity - 1);
  const [newQuantity, setNewQuantity] = useState(max);
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const preview = reduceLineRefundPreview({
    unitPriceCents: line.unitPriceCents,
    currentQuantity: line.quantity,
    newQuantity,
    orderSubtotalCents: order.subtotalCents,
    orderTaxCents: order.taxCents,
  });

  const setClampedQuantity = (raw: string) => {
    const n = Math.round(Number(raw));
    setNewQuantity(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min);
  };

  const submit = async () => {
    if (preview.deltaQuantity <= 0 || busy) return;
    setBusy(true);
    try {
      const res = await reduceOrderLine(order.id, {
        orderLineId: line.id,
        newQuantity,
        restock,
        reason: reason.trim() || undefined,
        idempotencyKey,
      });
      app.toast(
        `Refunded ${money(res.refundedCents, order.currency)}.${res.restocked ? " Item restocked." : ""}`,
        "check",
      );
      if (res.restockError) {
        app.toast("Refund issued, but the item could not be restocked. Check your inventory.", "warn");
      }
      onDone();
      onClose();
    } catch (err) {
      if (err instanceof DashboardApiError && err.code === "concurrent_edit") {
        app.toast("The order changed while you were editing. Reload and try again.", "warn", "critical");
      } else {
        app.toast(err instanceof DashboardApiError ? err.message : "Couldn't reduce this line.", "warn", "critical");
      }
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
        aria-label="Reduce line quantity"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Reduce {line.title}</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            Currently {line.quantity} × {money(line.unitPriceCents, order.currency)}.
            {min > 0 ? ` ${min} already shipped and can't be reduced away.` : ""}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>New quantity</span>
              <input
                className="cd-input tabular-nums"
                type="number"
                min={min}
                max={max}
                value={newQuantity}
                onChange={(e) => setClampedQuantity(e.target.value)}
                style={{ width: 100 }}
              />
            </label>
            <label className="cd-field">
              <span>Reason (optional)</span>
              <input
                className="cd-input"
                type="text"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Buyer requested fewer units"
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
              <span className="cd-caption">Restock the reduced units</span>
            </label>
            <div className="cd-caption">
              {preview.deltaQuantity > 0
                ? `Refund ${money(preview.refundCents, order.currency)} (includes tax share)`
                : "Choose a lower quantity to refund the difference."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn
                kind="primary"
                icon="reduce"
                onClick={submit}
                disabled={busy || preview.deltaQuantity <= 0}
              >
                {busy
                  ? "Refunding…"
                  : `Refund ${money(preview.refundCents, order.currency)} and update the order?`}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
