import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

// Move stock between two locations. Calls the inventory engine (createTransfer),
// which decrements the source and adds to the destination atomically. Instant
// lands in on_hand; in-transit lands in incoming until received.
export default function TransferModal({
  app,
  variantId,
  onClose,
  onDone,
}: {
  app: DashboardCtx;
  variantId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [locations, setLocations] = useState<client.LocationVM[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [qty, setQty] = useState(1);
  const [mode, setMode] = useState<"instant" | "in_transit">("instant");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.fetchLocations().then(setLocations).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!from || !to || from === to || qty < 1) {
      app.toast("Pick two different locations and a quantity.", "warn");
      return;
    }
    setBusy(true);
    try {
      await client.createTransfer({ variantId, fromLocationId: from, toLocationId: to, qty, mode });
      app.toast("Stock moved.", "check");
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Transfer failed.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        background: "color-mix(in oklch, black 32%, transparent)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Move stock"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 12 }}>Move stock</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>From</span>
              <select className="cd-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Choose…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label className="cd-field">
              <span>To</span>
              <select className="cd-input" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label className="cd-field">
              <span>Quantity</span>
              <input
                className="cd-input tabular-nums"
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Math.trunc(Number(e.target.value)) || 1))}
              />
            </label>
            <label className="cd-field">
              <span>When</span>
              <select className="cd-input" value={mode} onChange={(e) => setMode(e.target.value as "instant" | "in_transit")}>
                <option value="instant">Move now</option>
                <option value="in_transit">Mark in transit</option>
              </select>
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" onClick={submit} disabled={busy}>{busy ? "Moving…" : "Move"}</Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
