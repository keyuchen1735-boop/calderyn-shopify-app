// Calderyn DashV2 — Inventory screen (LIVE).
// Ported from the inventory section of the prototype's screen-ops.jsx, wired to
// the live data layer. Self-fetches SKUs via fetchSkus() (there is no app.skus).
// Renders the prototype's inventory table: title, sku code, on-hand, days of
// cover, velocity, a location distribution bar, and a status pill. Rows that map
// to an open alert are clickable through to that alert.
import { useEffect, useState } from "react";
import { Btn, Card, Pill, Segmented, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { fetchSkus, relocateSku, DashboardApiError } from "~/lib/dashboard/client";
import type { DashboardCtx } from "../context";
import type { SkuVM, AlertVM } from "../view-models";

type PillTone = "neutral" | "success" | "critical" | "accent" | "warn";

const SKU_STATUS: Record<string, { label: string; tone: PillTone }> = {
  stockout: { label: "Stocked out", tone: "critical" },
  risk: { label: "At risk", tone: "warn" },
  reorder: { label: "Reorder soon", tone: "warn" },
  misplaced: { label: "Wrong location", tone: "accent" },
  healthy: { label: "Healthy", tone: "success" },
};

/* ---------- Location distribution bar ---------- */
function LocationBar({ locations }: { locations: Record<string, number> }) {
  const total = Object.values(locations).reduce((s, v) => s + v, 0) || 1;
  const colors = [
    "var(--accent)",
    "color-mix(in oklch, var(--accent) 65%, white)",
    "color-mix(in oklch, var(--accent) 40%, white)",
    "color-mix(in oklch, var(--accent) 22%, white)",
  ];
  return (
    <div
      className="cd-locbar"
      title={Object.entries(locations)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · ")}
    >
      {Object.entries(locations).map(
        ([k, v], i) =>
          v > 0 && (
            <div
              key={k}
              style={{ width: `${(v / total) * 100}%`, background: colors[i % colors.length] }}
            ></div>
          ),
      )}
    </div>
  );
}

/* ---------- Screen ---------- */
type Filter = "All" | "Needs attention" | "Healthy";

export default function Inventory({ app }: { app: DashboardCtx }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [skus, setSkus] = useState<SkuVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relocating, setRelocating] = useState<SkuVM | null>(null);
  const [busy, setBusy] = useState(false);
  // app.refresh() reloads the shell's data but not this screen's self-fetched
  // SKUs; bump this counter to re-run the fetch after a successful relocate.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSkus()
      .then((rows) => {
        if (!alive) return;
        setSkus(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(
          err instanceof DashboardApiError ? err.message : "Couldn't load inventory.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function confirmRelocate(skuId: string, fromId: string, toId: string, qty: number) {
    setBusy(true);
    try {
      const { outcome } = await relocateSku(skuId, {
        fromLocationId: fromId,
        toLocationId: toId,
        quantity: qty,
      });
      if (outcome === "succeeded") {
        app.toast("Inventory transfer executed", "box", "success");
        setRelocating(null);
        setReloadKey((k) => k + 1);
        app.refresh();
      } else {
        app.toast("Transfer recorded as failed — check the audit log", "warn", "critical");
      }
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't move inventory.",
        "warn",
        "critical",
      );
    } finally {
      setBusy(false);
    }
  }

  const shown = skus.filter((s) =>
    filter === "All"
      ? true
      : filter === "Healthy"
        ? s.status === "healthy"
        : s.status !== "healthy",
  );

  // A SKU row is clickable when an open alert references it. The prototype keyed
  // on the alert's `sku` string starting with the SKU title prefix.
  const linkedAlert = (sku: SkuVM): AlertVM | undefined =>
    app.alerts.find(
      (a) => a.status === "open" && a.sku != null && sku.title.startsWith(a.sku.split(" — ")[0]),
    );

  return (
    <div className="cd-screen">
      <ScreenHeaderInline
        loading={loading}
        total={skus.length}
        filter={filter}
        onFilter={setFilter}
      />
      <Card pad={false}>
        {loading ? (
          <Placeholder icon="box" title="Loading inventory" sub="Reading on-hand and velocity across your locations." />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load inventory" sub={error} />
        ) : skus.length === 0 ? (
          <Placeholder icon="box" title="No SKUs" sub="Connect a store and your tracked SKUs will appear here." />
        ) : (
          <>
            <div className="cd-table-head">
              <span style={{ flex: "1 1 0", minWidth: 140 }}>SKU</span>
              <span style={{ width: 64, textAlign: "right" }}>On hand</span>
              <span style={{ width: 52, textAlign: "right" }}>Cover</span>
              <span style={{ width: 64, textAlign: "right" }}>Velocity</span>
              <span style={{ width: 104 }}>By location</span>
              <span style={{ width: 120 }}>Main demand</span>
              <span style={{ width: 84 }}></span>
              <span style={{ width: 92, textAlign: "right" }}>Status</span>
            </div>
            <div className="cd-rows">
              {shown.map((s) => {
                const st = SKU_STATUS[s.status] ?? SKU_STATUS.healthy;
                const alert = linkedAlert(s);
                return (
                  <div
                    key={s.id}
                    className="cd-row"
                    style={{ cursor: alert ? "pointer" : "default" }}
                    role={alert ? "button" : undefined}
                    tabIndex={alert ? 0 : undefined}
                    onClick={alert ? () => app.navigate("alerts", alert.id) : undefined}
                    onKeyDown={
                      alert
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              app.navigate("alerts", alert.id);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="min-w-0" style={{ flex: "1 1 0", minWidth: 140 }}>
                      <div className="cd-row-title truncate">{s.title}</div>
                      <div className="cd-caption truncate">
                        {s.category ? `${s.sku} · ${s.category}` : s.sku}
                      </div>
                    </div>
                    <span
                      className="tabular-nums cd-row-num"
                      style={{
                        width: 64,
                        textAlign: "right",
                        color: s.on_hand === 0 ? "var(--red)" : "var(--text-1)",
                      }}
                    >
                      {s.on_hand}
                    </span>
                    <span
                      className="tabular-nums"
                      style={{
                        width: 52,
                        textAlign: "right",
                        color: s.days_of_cover <= 9 ? "var(--red)" : "var(--text-2)",
                      }}
                    >
                      {s.days_of_cover}d
                    </span>
                    <span
                      className="tabular-nums cd-caption"
                      style={{ width: 64, textAlign: "right" }}
                    >
                      {s.velocity.toFixed(1)}/day
                    </span>
                    <span style={{ width: 104 }}>
                      <LocationBar locations={s.locations} />
                    </span>
                    <span style={{ width: 120 }}>
                      {s.demand ? (
                        <span
                          className="cd-caption tabular-nums"
                          title={`${s.demand.units_30d} units/30d in ${s.demand.region} · ${s.demand.stock_in_region} in stock there`}
                          style={{
                            color:
                              s.demand.stock_in_region === 0 ? "var(--red)" : "var(--text-2)",
                          }}
                        >
                          {s.demand.region} · {s.demand.units_30d}/30d
                        </span>
                      ) : (
                        <span className="cd-caption">—</span>
                      )}
                    </span>
                    {/* Wrapper stops click/keydown bubbling to the row, which
                        otherwise navigates to the linked alert. */}
                    <span
                      style={{ width: 84, display: "flex", justifyContent: "flex-end" }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {s.suggested_transfer && (
                        <Btn small onClick={() => setRelocating(s)}>
                          Relocate
                        </Btn>
                      )}
                    </span>
                    <span style={{ width: 92, display: "flex", justifyContent: "flex-end" }}>
                      <Pill tone={st.tone}>{st.label}</Pill>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>
      <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <CDIcon name="box" size={13} /> Location shading runs from your largest fulfillment center
        down. Rows with an open alert are clickable.
      </p>
      {relocating && (
        <RelocateDialog
          sku={relocating}
          busy={busy}
          onClose={() => setRelocating(null)}
          onConfirm={(fromId, toId, qty) => confirmRelocate(relocating.id, fromId, toId, qty)}
        />
      )}
    </div>
  );
}

/* ---------- Relocate dialog ---------- */
// No shared modal primitive exists in the dashboard kit yet, so this renders a
// minimal fixed backdrop + centered Card, with cd-field/cd-input form controls
// (the Predictor screen's form styling).
function RelocateDialog({
  sku,
  busy,
  onClose,
  onConfirm,
}: {
  sku: SkuVM;
  busy: boolean;
  onClose: () => void;
  onConfirm: (fromId: string, toId: string, qty: number) => void;
}) {
  const suggestion = sku.suggested_transfer;
  const sources = sku.locations_detail.filter((l) => l.available > 0);
  // The dashboard API has no shop-locations endpoint; destinations are the
  // SKU's own ACTIVE locations (the server rejects inactive destinations)
  // plus the suggested destination (active by construction in the view's
  // dest pick), deduped by id. Sources stay unfiltered: draining an
  // inactive location is valid.
  const destinations = [
    ...sku.locations_detail.filter((l) => l.active),
    ...(suggestion && !sku.locations_detail.some((l) => l.id === suggestion.to_location_id)
      ? [
          {
            id: suggestion.to_location_id,
            name: suggestion.to_location_name,
            region: null,
            available: 0,
            active: true,
          },
        ]
      : []),
  ];

  const [fromId, setFromId] = useState(
    suggestion && sources.some((l) => l.id === suggestion.from_location_id)
      ? suggestion.from_location_id
      : sources[0]?.id ?? "",
  );
  const [toId, setToId] = useState(suggestion?.to_location_id ?? destinations[0]?.id ?? "");
  const [qty, setQty] = useState(suggestion ? String(suggestion.recommended_delta) : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const source = sources.find((l) => l.id === fromId);
  const qtyNum = /^\d+$/.test(qty.trim()) ? Number(qty.trim()) : NaN;
  const valid =
    qtyNum > 0 &&
    fromId !== "" &&
    toId !== "" &&
    fromId !== toId &&
    source != null &&
    qtyNum <= source.available;

  return (
    // Backdrop click closes; Escape is handled above, so the static-element
    // click handler is a pointer convenience, not the only dismissal path.
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
        aria-label={`Relocate ${sku.title}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 6 }}>
            Relocate {sku.title}
          </div>
          {sku.demand && (
            <p className="cd-caption" style={{ marginBottom: 12 }}>
              {sku.demand.units_30d} units sold in {sku.demand.region} over 30 days ·{" "}
              {sku.demand.stock_in_region} in stock there.
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="cd-field">
              <span>From</span>
              <select
                className="cd-input"
                value={fromId}
                onChange={(e) => setFromId(e.target.value)}
              >
                {sources.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.available} available)
                  </option>
                ))}
              </select>
            </label>
            <label className="cd-field">
              <span>To</span>
              <select className="cd-input" value={toId} onChange={(e) => setToId(e.target.value)}>
                {destinations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="cd-field">
              <span>Quantity</span>
              <input
                className="cd-input tabular-nums"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
            <p className="cd-caption">
              Recorded in the audit log. Reversible via Undo for 24 hours.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>
                Cancel
              </Btn>
              <Btn
                kind="primary"
                onClick={() => onConfirm(fromId, toId, qtyNum)}
                disabled={busy || !valid}
              >
                Move inventory
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
function ScreenHeaderInline({
  loading,
  total,
  filter,
  onFilter,
}: {
  loading: boolean;
  total: number;
  filter: Filter;
  onFilter: (next: Filter) => void;
}) {
  return (
    <header className="cd-screen-head" data-screen-label="Inventory">
      <div>
        <h1 className="cd-h1">Inventory</h1>
        <p className="cd-sub">
          {loading
            ? "Loading SKUs across your locations…"
            : `${total} tracked SKUs`}
        </p>
      </div>
      <div className="flex items-center gap-2.5">
        <Segmented
          small
          value={filter}
          onChange={(v) => onFilter(v as Filter)}
          options={["All", "Needs attention", "Healthy"]}
        />
      </div>
    </header>
  );
}
