import { useEffect, useState } from "react";
import { Btn, Card, Pill, Placeholder } from "../ui";
import { ProductsSubTabs } from "../subtabs";
import { timeAgo } from "../format";
import { DashboardApiError, receiveTransfer } from "~/lib/dashboard/client";
import {
  fetchAllPendingTransfers,
  type ShopTransferVM,
} from "~/lib/dashboard/transfers-client";
import type { DashboardCtx } from "../context";

// Shop-wide view of in-transit stock moves. The transfer GET only returns
// state=in_transit rows, so every row here is receivable; receiving lands the
// units in on_hand at the destination and drops the row from the next load.

const GRID = "1fr 1.4fr 0.7fr 1.4fr 1.1fr";

function VariantCell({ row }: { row: ShopTransferVM }) {
  if (row.sku) {
    return (
      <div className="min-w-0">
        <div className="cd-row-title truncate">{row.sku}</div>
        {row.variantTitle && <div className="cd-caption truncate">{row.variantTitle}</div>}
      </div>
    );
  }
  if (row.variantTitle) {
    return <div className="cd-row-title truncate">{row.variantTitle}</div>;
  }
  // No label survived the join — show the real id, clearly marked as one.
  return (
    <div className="min-w-0">
      <div className="cd-row-title tabular-nums truncate">{row.variantId.slice(0, 8)}</div>
      <div className="cd-caption">Variant id</div>
    </div>
  );
}

export default function Transfers({ app }: { app: DashboardCtx }) {
  const [rows, setRows] = useState<ShopTransferVM[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [receiving, setReceiving] = useState<string | null>(null);
  // Bumped after a successful receive so the effect re-pulls the list.
  const [reloadKey, setReloadKey] = useState(0);
  const toast = app.toast;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchAllPendingTransfers()
      .then((t) => {
        if (alive) setRows(t);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg =
          err instanceof DashboardApiError ? err.message : "Could not load transfers.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [toast, reloadKey]);

  const onReceive = async (transferId: string) => {
    if (receiving) return;
    setReceiving(transferId);
    try {
      await receiveTransfer(transferId);
      toast("Received into stock.", "check");
      setReloadKey((k) => k + 1);
    } catch (err) {
      const msg =
        err instanceof DashboardApiError ? err.message : "Couldn't receive the transfer.";
      toast(msg, "warn", "critical");
    } finally {
      setReceiving(null);
    }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">Stock transfers</p>
        </div>
      </header>

      <ProductsSubTabs app={app} />

      <Card pad={false}>
        {!rows ? (
          <Placeholder
            icon="truck"
            title={loading ? "Loading transfers" : "Transfers unavailable"}
            sub={
              loading
                ? "Reading in-transit stock moves."
                : "Could not load transfers just now. Refresh to try again."
            }
          />
        ) : rows.length === 0 ? (
          <>
            <Placeholder
              icon="truck"
              title="No transfers in flight"
              sub="Start one from Inventory — moves marked in transit land here until received."
            />
            <div className="flex justify-center" style={{ paddingBottom: 28 }}>
              <Btn small icon="box" onClick={() => app.navigate("inventory")}>
                Open inventory
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>Transfer</span>
              <span>SKU / variant</span>
              <span>Qty</span>
              <span>Route</span>
              <span>Status</span>
            </div>
            {rows.map((r) => (
              <div key={r.id} className="cd-trow" style={{ gridTemplateColumns: GRID }}>
                <div className="min-w-0">
                  <div className="cd-row-title tabular-nums truncate">
                    {r.id.slice(0, 8).toUpperCase()}
                  </div>
                  <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                </div>
                <VariantCell row={r} />
                <div className="cd-row-num tabular-nums">{r.qty}</div>
                <div className="cd-caption truncate">
                  {r.fromName} → {r.toName}
                </div>
                <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                  <Pill tone="accent" icon="truck">
                    In transit
                  </Pill>
                  <Btn
                    small
                    icon="check"
                    disabled={receiving === r.id}
                    onClick={() => {
                      void onReceive(r.id);
                    }}
                  >
                    {receiving === r.id ? "Receiving…" : "Mark received"}
                  </Btn>
                </div>
              </div>
            ))}
          </>
        )}
      </Card>
    </div>
  );
}
