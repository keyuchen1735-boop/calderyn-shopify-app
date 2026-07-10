import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { DashboardApiError } from "~/lib/dashboard/client";
import { fulfillOrder, type OrderDetail } from "~/lib/dashboard/orders-client";
import { useModalEntrance } from "./order-modal-motion";

// Ship some or all of an order's open lines. Defaults every line's quantity to what's still
// remaining (quantity - fulfilledQuantity) so the common case — ship everything in one go — is
// zero-input. The idempotency key is minted once per open (same pattern as RefundModal) so a
// double-submit or a retried request after a network blip can never double-fulfill.
export default function FulfillModal({
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
  const unfulfilled = order.lines.filter((l) => l.fulfilledQuantity < l.quantity);
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(unfulfilled.map((l) => [l.id, l.quantity - l.fulfilledQuantity])),
  );
  const [tracking, setTracking] = useState("");
  const [carrier, setCarrier] = useState("");
  const [notify, setNotify] = useState(true);
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

  const setLineQty = (lineId: string, remaining: number, raw: string) => {
    const n = Math.round(Number(raw));
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(remaining, n)) : 0;
    setQty((prev) => ({ ...prev, [lineId]: clamped }));
  };

  const submit = async () => {
    const lines = unfulfilled
      .map((l) => ({ orderLineId: l.id, quantity: qty[l.id] ?? 0 }))
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) {
      app.toast("Enter at least one unit to fulfill.", "warn");
      return;
    }
    setBusy(true);
    try {
      const res = await fulfillOrder(order.id, {
        lines,
        trackingNumber: tracking.trim() || undefined,
        carrier: carrier.trim() || undefined,
        notify,
        idempotencyKey,
      });
      app.toast(
        `Marked ${res.fulfilledUnits} item${res.fulfilledUnits === 1 ? "" : "s"} fulfilled.${res.notified ? " Customer notified." : ""}`,
        "check",
      );
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't fulfill this order.", "warn", "critical");
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
        aria-label="Fulfill order"
        onClick={(e) => e.stopPropagation()}
        className="cd-modal-dialog"
        style={{ maxWidth: 480 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Fulfill {order.ref}</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            Choose how many units of each line are shipping. Anything left at zero stays open for a
            later fulfillment.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            {unfulfilled.map((l) => {
              const remaining = l.quantity - l.fulfilledQuantity;
              return (
                <div key={l.id} className="flex items-center justify-between" style={{ gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="cd-row-title truncate">{l.title}</div>
                    <div className="cd-caption">
                      {l.sku ? `${l.sku} · ` : ""}
                      {remaining} of {l.quantity} open
                    </div>
                  </div>
                  <input
                    className="cd-input tabular-nums"
                    type="number"
                    min={0}
                    max={remaining}
                    value={qty[l.id] ?? 0}
                    onChange={(e) => setLineQty(l.id, remaining, e.target.value)}
                    style={{ width: 72, textAlign: "right", flexShrink: 0 }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>Tracking number (optional)</span>
              <input
                className="cd-input"
                type="text"
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="1Z999AA10123456784"
              />
            </label>
            <label className="cd-field">
              <span>Carrier (optional)</span>
              <input
                className="cd-input"
                type="text"
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="UPS"
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              <span className="cd-caption">Email the customer a shipping confirmation</span>
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" icon="truck" onClick={submit} disabled={busy}>
                {busy ? "Fulfilling…" : "Mark fulfilled"}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
