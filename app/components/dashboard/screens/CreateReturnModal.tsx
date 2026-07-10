import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { createOrderReturn, type CreateReturnLineInput, type OrderDetail } from "~/lib/dashboard/orders-client";
import { defaultReturnRefundCents, returnableQuantity } from "./return-preview";
import { useModalEntrance } from "./order-modal-motion";

const MAX_REASON_LENGTH = 500;

interface ReturnLineRow {
  orderLineId: string;
  title: string;
  sku: string | null;
  unitPriceCents: number;
  returnable: number;
  included: boolean;
  quantity: number;
  restock: boolean;
  refundCents: number;
  /** True once the merchant has typed into this line's refund field — stops the quantity stepper
   *  from silently overwriting a deliberate below-default refund (e.g. a restocking fee). */
  refundEdited: boolean;
}

function buildRows(order: OrderDetail): ReturnLineRow[] {
  return order.lines
    .map((line) => ({ line, returnable: returnableQuantity(line, order.returns) }))
    .filter(({ returnable }) => returnable > 0)
    .map(({ line, returnable }) => ({
      orderLineId: line.id,
      title: line.title,
      sku: line.sku,
      unitPriceCents: line.unitPriceCents,
      returnable,
      included: false,
      quantity: returnable,
      restock: true,
      refundCents: defaultReturnRefundCents({
        unitPriceCents: line.unitPriceCents,
        quantity: returnable,
        orderSubtotalCents: order.subtotalCents,
        orderTaxCents: order.taxCents,
      }),
      refundEdited: false,
    }));
}

// Open a new return against a native order (orders Phase 4, Task 2): per-line quantity/restock/
// refund, with the refund defaulted from the SAME reduction-tax formula ReduceLineModal previews
// (return-preview.ts's defaultReturnRefundCents) and editable only DOWN from that default — a
// merchant can refund less (a restocking fee) but the server refuses a refund exceeding the
// default outright. The refund itself is issued later, when the return is marked received; this
// only records what's coming back.
export default function CreateReturnModal({
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
  const [rows, setRows] = useState<ReturnLineRow[]>(() => buildRows(order));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { overlayRef, dialogRef } = useModalEntrance();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const updateRow = (orderLineId: string, patch: Partial<ReturnLineRow>) => {
    setRows((cur) => cur.map((r) => (r.orderLineId === orderLineId ? { ...r, ...patch } : r)));
  };

  const setQuantity = (orderLineId: string, raw: string) => {
    setRows((cur) =>
      cur.map((r) => {
        if (r.orderLineId !== orderLineId) return r;
        const n = Math.round(Number(raw));
        const quantity = Number.isFinite(n) ? Math.max(1, Math.min(r.returnable, n)) : 1;
        const defaultCents = defaultReturnRefundCents({
          unitPriceCents: r.unitPriceCents,
          quantity,
          orderSubtotalCents: order.subtotalCents,
          orderTaxCents: order.taxCents,
        });
        // A quantity change recomputes the default; an untouched refund tracks it, a deliberately
        // edited one is just re-clamped to the (possibly lower) new ceiling.
        const refundCents = r.refundEdited ? Math.min(r.refundCents, defaultCents) : defaultCents;
        return { ...r, quantity, refundCents };
      }),
    );
  };

  const setRefundDollars = (orderLineId: string, raw: string) => {
    setRows((cur) =>
      cur.map((r) => {
        if (r.orderLineId !== orderLineId) return r;
        const defaultCents = defaultReturnRefundCents({
          unitPriceCents: r.unitPriceCents,
          quantity: r.quantity,
          orderSubtotalCents: order.subtotalCents,
          orderTaxCents: order.taxCents,
        });
        const n = Math.round(Number(raw) * 100);
        const refundCents = Number.isFinite(n) ? Math.max(0, Math.min(defaultCents, n)) : 0;
        return { ...r, refundCents, refundEdited: true };
      }),
    );
  };

  const includedRows = rows.filter((r) => r.included);
  const totalRefundCents = includedRows.reduce((sum, r) => sum + r.refundCents, 0);
  const canSubmit = includedRows.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) {
      app.toast("Select at least one item to return.", "warn");
      return;
    }
    setBusy(true);
    try {
      const lines: CreateReturnLineInput[] = includedRows.map((r) => ({
        orderLineId: r.orderLineId,
        quantity: r.quantity,
        restock: r.restock,
        refundCents: r.refundCents,
      }));
      await createOrderReturn(order.id, { lines, reason: reason.trim() || undefined });
      app.toast(`Return created for ${money(totalRefundCents, order.currency)} when received.`, "check");
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't create this return.", "warn", "critical");
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
        aria-label="Create return"
        onClick={(e) => e.stopPropagation()}
        className="cd-modal-dialog"
        style={{ maxWidth: 520 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Create return</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            The refund is issued when you mark the return received.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "50vh", overflowY: "auto" }}>
            {rows.map((r) => (
              <div key={r.orderLineId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label className="flex items-start" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={r.included}
                    onChange={(e) => updateRow(r.orderLineId, { included: e.target.checked })}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cd-row-title truncate">{r.title}</div>
                    <div className="cd-caption">
                      {r.sku ? `${r.sku} · ` : ""}
                      {r.returnable} returnable · {money(r.unitPriceCents, order.currency)} each
                    </div>
                  </div>
                </label>
                {r.included && (
                  <div className="flex items-center" style={{ gap: 10, paddingLeft: 24, flexWrap: "wrap" }}>
                    <label className="cd-field" style={{ width: 90 }}>
                      <span>Qty</span>
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min={1}
                        max={r.returnable}
                        value={r.quantity}
                        onChange={(e) => setQuantity(r.orderLineId, e.target.value)}
                      />
                    </label>
                    <label className="cd-field" style={{ width: 120 }}>
                      <span>Refund ({order.currency.toUpperCase()})</span>
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min={0}
                        step="0.01"
                        value={(r.refundCents / 100).toFixed(2)}
                        onChange={(e) => setRefundDollars(r.orderLineId, e.target.value)}
                      />
                    </label>
                    <label className="flex items-center" style={{ gap: 6, marginTop: 18 }}>
                      <input
                        type="checkbox"
                        checked={r.restock}
                        onChange={(e) => updateRow(r.orderLineId, { restock: e.target.checked })}
                      />
                      <span className="cd-caption">Restock</span>
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
            <label className="cd-field">
              <span>Reason (optional)</span>
              <input
                className="cd-input"
                type="text"
                maxLength={MAX_REASON_LENGTH}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Buyer requested a return"
              />
            </label>
            <div className="cd-caption">
              {includedRows.length === 0
                ? "Select at least one item above."
                : `${includedRows.length} item${includedRows.length === 1 ? "" : "s"} selected · Refund ${money(totalRefundCents, order.currency)} when received.`}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" icon="undo" onClick={submit} disabled={!canSubmit}>
                {busy ? "Creating…" : "Create return"}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
