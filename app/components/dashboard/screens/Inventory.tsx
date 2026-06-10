// Calderyn DashV2 — Inventory screen (LIVE).
// Ported from the inventory section of the prototype's screen-ops.jsx, wired to
// the live data layer. Self-fetches SKUs via fetchSkus() (there is no app.skus).
// Renders the prototype's inventory table: title, sku code, on-hand, days of
// cover, velocity, a location distribution bar, and a status pill. Rows that map
// to an open alert are clickable through to that alert.
import { useEffect, useState } from "react";
import { Card, Pill, Segmented, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { fetchSkus, DashboardApiError } from "~/lib/dashboard/client";
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
  }, []);

  const shown = skus.filter((s) =>
    filter === "All"
      ? true
      : filter === "Healthy"
        ? s.status === "healthy"
        : s.status !== "healthy",
  );
  const attention = skus.filter((s) => s.status !== "healthy").length;

  // A SKU row is clickable when an open alert references it. The prototype keyed
  // on the alert's `sku` string starting with the SKU title prefix.
  const linkedAlert = (sku: SkuVM): AlertVM | undefined =>
    app.alerts.find(
      (a) => a.status === "open" && a.sku != null && sku.title.startsWith(a.sku.split(" — ")[0]),
    );

  return (
    <div className="cd-screen">
      <ScreenHeaderInline
        attention={attention}
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
              <span style={{ width: 92 }}></span>
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
    </div>
  );
}

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
function ScreenHeaderInline({
  attention,
  loading,
  total,
  filter,
  onFilter,
}: {
  attention: number;
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
            : `${total} tracked SKUs · ${attention} need attention`}
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
