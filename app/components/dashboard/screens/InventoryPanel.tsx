import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Pan, TableSkeleton } from "../ui";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import TransferModal from "./TransferModal";

// Per-(variant, location) stock editor for the product editor. Reads owned
// balances and writes every change through the inventory engine (which journals
// the ledger + projects the stock observation). on-hand and reorder point are
// edited inline; "Move stock" opens the transfer modal; a per-row "Damaged"
// control marks units unavailable; in-transit transfers are received from the
// "In transit" list; "History" shows recent ledger entries.
export default function InventoryPanel({ app, variantId }: { app: DashboardCtx; variantId: string }) {
  const [rows, setRows] = useState<client.VariantBalanceVM[]>([]);
  const [pending, setPending] = useState<client.PendingTransferVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [moving, setMoving] = useState(false);
  const [damaging, setDamaging] = useState<string | null>(null);
  const [damageQty, setDamageQty] = useState(1);
  const [history, setHistory] = useState<client.LedgerEntryVM[] | null>(null);

  // Track load failure so a transient API/DB error is NOT rendered as the "No stock locations yet"
  // empty state (which would make a fully-stocked variant look empty, inviting a double-count).
  const reload = () =>
    Promise.all([
      client.fetchVariantInventory(variantId).then(setRows),
      client.fetchPendingTransfers(variantId).then(setPending),
    ])
      .then(() => setLoadError(false))
      .catch(() => {
        // A failed REFRESH after a write must not blank a panel that already has
        // numbers on screen (the write itself succeeded — only the re-read broke).
        // Keep the stale rows, say so, and reserve loadError for the case where
        // there is nothing to show at all.
        if (rows.length > 0) {
          app.toast("Saved, but the numbers may be stale — reopen to refresh.", "warn");
        } else {
          setLoadError(true);
        }
      });
  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId]);

  const onSetOnHand = async (locationId: string, onHand: number) => {
    try { await client.setOnHand(variantId, locationId, onHand); await reload(); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Couldn't update stock.", "warn", "critical"); }
  };
  const onSetReorder = async (locationId: string, rp: number | null) => {
    try { await client.setVariantReorderPoint(variantId, locationId, rp); await reload(); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Couldn't set reorder point.", "warn", "critical"); }
  };
  const onConfirmDamage = async (locationId: string, qty: number) => {
    try {
      await client.markVariantUnavailable(variantId, locationId, qty, "damaged");
      setDamaging(null); setDamageQty(1); await reload();
      app.toast("Marked unavailable.", "check");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't mark unavailable.", "warn", "critical");
    }
  };
  const toggleHistory = async () => {
    if (history) { setHistory(null); return; }
    try { setHistory(await client.fetchInventoryHistory(variantId)); }
    catch { app.toast("Couldn't load history.", "warn", "critical"); }
  };
  const onReceive = async (transferId: string) => {
    try { await client.receiveTransfer(transferId); await reload(); app.toast("Received into stock.", "check"); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Couldn't receive the transfer.", "warn", "critical"); }
  };

  if (loading) return <TableSkeleton rows={2} />;
  if (!rows.length) {
    // Distinguish a genuinely empty variant from a failed load: showing "no stock" for a stocked
    // variant that merely failed to load would mislead the merchant into re-adding stock.
    return loadError ? (
      <div className="cd-caption">Couldn&apos;t load stock. Please try again.</div>
    ) : (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="cd-caption">No stock locations yet.</span>
        <Btn small onClick={() => app.navigate("locations-settings")}>Open locations</Btn>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <Btn small icon="swap" onClick={() => setMoving(true)}>Move stock</Btn>
        <Btn small icon="clock" onClick={toggleHistory}>{history ? "Hide history" : "History"}</Btn>
      </div>

      <Pan min={760}>
      <div className="cd-table-head">
        <span style={{ flex: "1 1 0", minWidth: 120 }}>Location</span>
        <span style={{ width: 92 }}>On hand</span>
        <span style={{ width: 70, textAlign: "right" }}>Reserved</span>
        <span style={{ width: 70, textAlign: "right" }}>Incoming</span>
        <span style={{ width: 78, textAlign: "right" }}>Available</span>
        <span style={{ width: 96 }}>Reorder at</span>
        <span style={{ width: 96 }} />
      </div>
      <div className="cd-rows">
        {rows.map((r) => {
          const low = r.reorderPoint != null && r.available <= r.reorderPoint;
          return (
            <div className="cd-row" key={r.locationId}>
              <span style={{ flex: "1 1 0", minWidth: 120 }}>
                {r.locationName}
                {low && <span style={{ color: "var(--red)", marginLeft: 8, fontWeight: 600 }}>Low</span>}
              </span>
              <span style={{ width: 92 }}>
                <input
                  // Value-derived key so the input REMOUNTS (and re-reads defaultValue) whenever the
                  // server on-hand changes — e.g. after receiving a transfer — instead of keeping a
                  // stale uncontrolled value. Combined with the blur dirty-check, this prevents a
                  // no-edit blur from committing the pre-reload number and silently reverting stock.
                  key={`onhand:${r.locationId}:${r.onHand}`}
                  className="cd-input tabular-nums" type="number" min={0} defaultValue={r.onHand}
                  onBlur={(e) => {
                    const next = Math.max(0, Math.trunc(Number(e.target.value)) || 0);
                    if (next !== r.onHand) onSetOnHand(r.locationId, next); // only commit a real change
                  }}
                />
              </span>
              <span className="cd-caption tabular-nums" style={{ width: 70, textAlign: "right" }}>{r.reserved}</span>
              <span className="cd-caption tabular-nums" style={{ width: 70, textAlign: "right" }}>{r.incoming}</span>
              <span className="tabular-nums" style={{ width: 78, textAlign: "right", fontWeight: 600, color: low ? "var(--red)" : "var(--text-1)" }}>{r.available}</span>
              <span style={{ width: 96 }}>
                <input
                  // Same stale-value guard as on-hand: remount when the server reorder point changes.
                  key={`reorder:${r.locationId}:${r.reorderPoint ?? ""}`}
                  className="cd-input tabular-nums" type="number" min={0} defaultValue={r.reorderPoint ?? ""} placeholder="—"
                  onBlur={(e) => {
                    const next = e.target.value === "" ? null : Math.max(0, Math.trunc(Number(e.target.value)) || 0);
                    if (next !== r.reorderPoint) onSetReorder(r.locationId, next); // only commit a real change
                  }}
                />
              </span>
              <span style={{ width: 96 }}>
                {damaging === r.locationId ? (
                  <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input
                      className="cd-input tabular-nums" type="number" min={1} value={damageQty} style={{ width: 48 }}
                      onChange={(e) => setDamageQty(Math.max(1, Math.trunc(Number(e.target.value)) || 1))}
                    />
                    <Btn small kind="primary" onClick={() => onConfirmDamage(r.locationId, damageQty)}>Mark</Btn>
                  </span>
                ) : (
                  <Btn small onClick={() => { setDamaging(r.locationId); setDamageQty(1); }}>Damaged</Btn>
                )}
              </span>
            </div>
          );
        })}
      </div>
      </Pan>

      {pending.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="cd-caption" style={{ marginBottom: 4 }}>In transit</div>
          {pending.map((t) => (
            <div key={t.id} className="cd-row" style={{ alignItems: "center" }}>
              <span className="cd-caption" style={{ flex: "1 1 0" }}>
                {t.qty} · {t.fromName} → {t.toName}
              </span>
              <Btn small kind="primary" onClick={() => onReceive(t.id)}>Receive</Btn>
            </div>
          ))}
        </div>
      )}

      {history && (
        <div style={{ marginTop: 10 }}>
          <div className="cd-caption" style={{ marginBottom: 4 }}>Recent changes</div>
          {history.length === 0 ? (
            <div className="cd-caption">No history yet.</div>
          ) : (
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
              {history.map((h) => (
                <div key={h.id} className="cd-caption" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{h.entry_type}{h.reason ? ` · ${h.reason}` : ""}</span>
                  <span className="tabular-nums">{h.qty > 0 ? `+${h.qty}` : h.qty}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {moving && <TransferModal app={app} variantId={variantId} onClose={() => setMoving(false)} onDone={reload} />}
    </div>
  );
}
