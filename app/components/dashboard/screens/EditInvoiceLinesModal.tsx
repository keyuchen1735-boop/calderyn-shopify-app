import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { editInvoiceLines, type OrderDetail } from "~/lib/dashboard/orders-client";
import VariantPicker, { type PickedVariant } from "./VariantPicker";

interface EditLine {
  variantId: string;
  title: string;
  unitPriceCents: number;
  quantity: number;
}

const MIN_QTY = 1;
const MAX_QTY = 999;

// Wholesale line replacement on an UNPAID invoice (channel='invoice', state='checkout_pending') —
// executeEditInvoiceLines re-prices every line from the live catalog and recomputes totals, so
// this modal only needs to collect the desired {variantId, quantity} set, not send prices itself.
// Existing lines seed from the order's current lines (their variantId, carried by OrderDetail
// since Task 5); new lines come from the same VariantPicker the create-order composer uses.
export default function EditInvoiceLinesModal({
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
  const [lines, setLines] = useState<EditLine[]>(() => {
    // Line state (and React keys) are keyed by variantId, so two order_line rows sharing a
    // variant must merge into one editable line — otherwise a qty edit or Remove on one would
    // silently apply to both. The server replaces lines wholesale, so merging loses nothing.
    const byVariant = new Map<string, EditLine>();
    for (const l of order.lines) {
      if (l.variantId == null) continue;
      const existing = byVariant.get(l.variantId);
      if (existing) {
        existing.quantity = Math.min(MAX_QTY, existing.quantity + l.quantity);
      } else {
        byVariant.set(l.variantId, {
          variantId: l.variantId,
          title: l.title,
          unitPriceCents: l.unitPriceCents,
          quantity: l.quantity,
        });
      }
    }
    return [...byVariant.values()];
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addVariant = (v: PickedVariant) => {
    setLines((cur) => {
      const existing = cur.find((l) => l.variantId === v.variantId);
      if (existing) {
        return cur.map((l) =>
          l.variantId === v.variantId ? { ...l, quantity: Math.min(MAX_QTY, l.quantity + 1) } : l,
        );
      }
      return [...cur, { variantId: v.variantId, title: v.title, unitPriceCents: v.unitPriceCents, quantity: 1 }];
    });
  };

  const setQty = (variantId: string, raw: string) => {
    const n = Math.round(Number(raw));
    const clamped = Number.isFinite(n) ? Math.max(MIN_QTY, Math.min(MAX_QTY, n)) : MIN_QTY;
    setLines((cur) => cur.map((l) => (l.variantId === variantId ? { ...l, quantity: clamped } : l)));
  };

  const removeLine = (variantId: string) => {
    setLines((cur) => cur.filter((l) => l.variantId !== variantId));
  };

  const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);

  const submit = async () => {
    if (lines.length === 0 || busy) {
      if (lines.length === 0) app.toast("Add at least one line.", "warn");
      return;
    }
    setBusy(true);
    try {
      await editInvoiceLines(
        order.id,
        lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      );
      app.toast("Invoice updated.", "check");
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't update this invoice.", "warn", "critical");
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
        aria-label="Edit invoice items"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 520 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Edit {order.ref}</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            This invoice hasn&apos;t been paid yet, so its items can be replaced outright. Prices are
            re-quoted from your live catalog when you save.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
            {lines.length === 0 ? (
              <span className="cd-caption">No lines yet. Add at least one item below.</span>
            ) : (
              lines.map((l) => (
                <div key={l.variantId} className="flex items-center justify-between" style={{ gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cd-row-title truncate">{l.title}</div>
                    <div className="cd-caption">{money(l.unitPriceCents, order.currency)} each</div>
                  </div>
                  <input
                    className="cd-input tabular-nums"
                    type="number"
                    min={MIN_QTY}
                    max={MAX_QTY}
                    value={l.quantity}
                    onChange={(e) => setQty(l.variantId, e.target.value)}
                    style={{ width: 72, textAlign: "right", flexShrink: 0 }}
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(l.variantId)}
                    aria-label={`Remove ${l.title}`}
                    style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--text-3)" }}
                  >
                    <CDIcon name="x" size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
          <VariantPicker onPick={addVariant} disabled={busy} />
          <div className="cd-caption" style={{ marginTop: 12 }}>
            Subtotal {money(subtotalCents, order.currency)} (shipping and tax are re-quoted on save)
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn kind="primary" icon="pencil" onClick={submit} disabled={busy || lines.length === 0}>
              {busy ? "Saving…" : "Save changes"}
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}
