import { Btn, Card, Pill, Placeholder } from "../ui";
import { ProductsSubTabs } from "../subtabs";
import { timeAgo } from "../format";
import type { DashboardCtx } from "../context";
import type { AuditVM } from "../view-models";

// Purchase orders are audit rows: create_po_draft snapshots the PO into the
// action_audit row, so the list is a filtered view over app.audit — no extra
// fetch. The row carries only what the audit trail knows (target, detail,
// outcome, timestamps); supplier/ETA/status fields don't exist, so they are
// not shown.

const GRID = "1fr 1.6fr 1fr 1.2fr";

// Outcomes are the shared action vocabulary (app/lib/action-outcome.ts):
// succeeded | retrying | anything else = failure. An unknown outcome renders
// as itself, never as a false success.
function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "succeeded") return <Pill tone="success" icon="check">Drafted</Pill>;
  if (outcome === "retrying") return <Pill tone="warn" icon="clock">Retrying</Pill>;
  if (outcome === "failed") return <Pill tone="critical" icon="x">Failed</Pill>;
  return <Pill>{outcome}</Pill>;
}

function PoRow({ entry }: { entry: AuditVM }) {
  // The PDF route (dashboard/api/audit/:id/po.pdf) 404s unless the row's
  // params carry the PO snapshot — a failed draft has none, so no button.
  const hasPdf = entry.outcome !== "failed";
  return (
    <div className="cd-trow" style={{ gridTemplateColumns: GRID }}>
      <div className="cd-row-title tabular-nums truncate">
        {entry.id.slice(0, 8).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="cd-row-title truncate">{entry.target || "—"}</div>
        {entry.detail && <div className="cd-caption truncate">{entry.detail}</div>}
      </div>
      <div className="cd-caption">{timeAgo(entry.created_at)}</div>
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
        <OutcomeBadge outcome={entry.outcome} />
        {hasPdf && (
          <Btn
            small
            icon="download"
            onClick={() =>
              window.open(
                `/dashboard/api/audit/${encodeURIComponent(entry.id)}/po.pdf`,
                "_blank",
                "noopener",
              )
            }
          >
            Download PDF
          </Btn>
        )}
      </div>
    </div>
  );
}

export default function PurchaseOrders({ app }: { app: DashboardCtx }) {
  const pos = app.audit.filter((e) => e.action_kind === "create_po_draft");
  const loading = app.loading && app.audit.length === 0;

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">Purchase orders</p>
        </div>
      </header>

      <ProductsSubTabs app={app} />

      <Card pad={false}>
        {loading ? (
          <Placeholder
            icon="doc"
            title="Loading purchase orders"
            sub="Reading your action history for drafted POs."
          />
        ) : pos.length === 0 ? (
          <>
            <Placeholder
              icon="doc"
              title="No purchase orders yet"
              sub="Draft one from a restock alert — Calderyn snapshots it here as a downloadable PO."
            />
            <div className="flex justify-center" style={{ paddingBottom: 28 }}>
              <Btn small icon="bell" onClick={() => app.navigate("alerts")}>
                View alerts
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>PO</span>
              <span>Detail</span>
              <span>Drafted</span>
              <span>Actions</span>
            </div>
            {pos.map((e) => (
              <PoRow key={e.id} entry={e} />
            ))}
          </>
        )}
      </Card>
    </div>
  );
}
