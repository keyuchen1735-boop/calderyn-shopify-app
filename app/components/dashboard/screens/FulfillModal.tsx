import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  buyLabel,
  fulfillOrder,
  quoteLabelRates,
  type LabelRateView,
  type OrderDetail,
} from "~/lib/dashboard/orders-client";
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
  // Label buying (EasyPost): rates load on demand; picking one switches the submit into
  // "buy label & fulfill" mode. Manual tracking entry stays available as the default path.
  // The label buy carries its OWN idempotency key (minted per quote): sharing the manual
  // path's key would let a committed-but-error-looking manual fulfillment replay instead
  // of recording the label's tracking.
  const [labelRates, setLabelRates] = useState<LabelRateView[] | null>(null);
  const [labelShipmentId, setLabelShipmentId] = useState<string | null>(null);
  const [labelRateId, setLabelRateId] = useState<string | null>(null);
  const [labelIdempotencyKey, setLabelIdempotencyKey] = useState<string | null>(null);
  const { overlayRef, dialogRef } = useModalEntrance();

  const clearLabelQuote = () => {
    setLabelRates(null);
    setLabelShipmentId(null);
    setLabelRateId(null);
    setLabelIdempotencyKey(null);
  };

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
    // Loaded label rates were priced for the OLD quantities — a changed selection must
    // re-quote, never buy a label weighted for units that aren't shipping.
    if (labelRates !== null) clearLabelQuote();
  };

  const pendingLines = () =>
    unfulfilled
      .map((l) => ({ orderLineId: l.id, quantity: qty[l.id] ?? 0 }))
      .filter((l) => l.quantity > 0);

  const loadLabelRates = async () => {
    const lines = pendingLines();
    if (lines.length === 0) {
      app.toast("Enter at least one unit to fulfill.", "warn");
      return;
    }
    setBusy(true);
    try {
      const res = await quoteLabelRates(order.id, lines);
      setLabelShipmentId(res.shipmentId);
      setLabelRates(res.rates);
      setLabelRateId(res.rates[0]?.id ?? null);
      setLabelIdempotencyKey(crypto.randomUUID());
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't get label rates.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const lines = pendingLines();
    if (lines.length === 0) {
      app.toast("Enter at least one unit to fulfill.", "warn");
      return;
    }
    setBusy(true);
    try {
      if (labelShipmentId && labelRateId && labelIdempotencyKey) {
        const res = await buyLabel(order.id, {
          shipmentId: labelShipmentId,
          rateId: labelRateId,
          lines,
          notify,
          idempotencyKey: labelIdempotencyKey,
        });
        // Popup blockers eat window.open after slow awaits, so the label is never
        // "opened or lost": it lives on the order's Fulfillments card, and the toast
        // says so. A replay (retried request) already fulfilled on the first attempt.
        app.toast(
          res.replayed
            ? "This label was already bought and the order fulfilled. Find it on the order's Fulfillments card."
            : `Label bought${res.labelCostCents != null ? ` (${money(res.labelCostCents)})` : ""}${
                res.trackingNumber ? `, tracking ${res.trackingNumber}` : ""
              }. ${res.fulfilledUnits} item${res.fulfilledUnits === 1 ? "" : "s"} fulfilled.${
                res.notified ? " Customer notified." : ""
              } The label is on the order's Fulfillments card.`,
          "check",
        );
      } else {
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
      }
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't fulfill this order.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  const buyingLabel = !!(labelShipmentId && labelRateId && labelIdempotencyKey);

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
            {order.canBuyLabel && labelRates === null ? (
              <div className="flex items-center justify-between gap-3">
                <span className="cd-caption">
                  Buy a shipping label through your connected carrier and tracking fills itself.
                </span>
                <Btn icon="truck" onClick={loadLabelRates} disabled={busy}>
                  {busy ? "Getting rates…" : "Get label rates"}
                </Btn>
              </div>
            ) : null}
            {labelRates !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="cd-caption">
                  Buying a label charges your carrier account and fills tracking automatically.
                </span>
                {labelRates.map((r) => (
                  <label key={r.id} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-8" style={{ gap: 8, minWidth: 0 }}>
                      <input
                        type="radio"
                        name="labelRate"
                        checked={labelRateId === r.id}
                        onChange={() => setLabelRateId(r.id)}
                      />
                      <span className="cd-row-title truncate">
                        {r.carrier} {r.service}
                      </span>
                    </span>
                    <span className="cd-row-num tabular-nums" style={{ flexShrink: 0 }}>
                      {money(r.amountCents)}
                      {r.estDeliveryDays != null ? (
                        <span className="cd-caption"> · {r.estDeliveryDays}d</span>
                      ) : null}
                    </span>
                  </label>
                ))}
                <Btn onClick={clearLabelQuote} disabled={busy}>
                  Enter tracking manually instead
                </Btn>
              </div>
            ) : null}
            {!buyingLabel ? (
              <>
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
              </>
            ) : null}
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              <span className="cd-caption">Email the customer a shipping confirmation</span>
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" icon="truck" onClick={submit} disabled={busy}>
                {busy ? "Fulfilling…" : buyingLabel ? "Buy label & fulfill" : "Mark fulfilled"}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
