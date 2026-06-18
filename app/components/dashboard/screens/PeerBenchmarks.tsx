import { useId, useState } from "react";
import { Card, Pill } from "~/components/dashboard/ui";
import { CDIcon } from "~/components/dashboard/icons";
import type { PeerBenchmarks as Data, PeerKpi } from "~/lib/benchmarks/types";

export interface BenchmarkBarGeometry {
  bandStartPct: number; // left edge of the peer IQR box, 0..100
  bandWidthPct: number; // width of the IQR box, 0..100
  medianPct: number | null; // peer median tick, or null when unknown
  youPct: number | null; // the shop's own marker, or null when it has no value
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Lay the peer distribution out on a value axis spanning the IQR plus the shop's
// own value (so an outlier still lands on the track), padded 20% on each side so
// the box is never flush to the edge. Returns null when there's no peer band to
// draw — the caller then renders the locked/empty state instead of a bar.
export function benchmarkBarGeometry(kpi: PeerKpi): BenchmarkBarGeometry | null {
  const { p25, p50, p75, your_value, available } = kpi;
  if (!available || p25 === null || p75 === null) return null;

  const iqr = p75 - p25;
  const lo0 = Math.min(p25, your_value ?? p25);
  const hi0 = Math.max(p75, your_value ?? p75);
  const pad = (iqr > 0 ? iqr : Math.max(Math.abs(hi0), 1)) * 0.2;
  const domainLo = lo0 - pad;
  const span = hi0 + pad - domainLo || 1;
  const pos = (v: number) => clamp(((v - domainLo) / span) * 100, 0, 100);

  return {
    bandStartPct: pos(p25),
    bandWidthPct: pos(p75) - pos(p25),
    medianPct: p50 === null ? null : pos(p50),
    youPct: your_value === null ? null : pos(your_value),
  };
}

function fmtValue(kpi: PeerKpi, v: number | null): string {
  if (v === null) return "—";
  return kpi.unit === "USD" ? `$${v.toFixed(2)}` : `${(v * 100).toFixed(1)}%`;
}

function categoryLabel(niche: string): string {
  return niche.startsWith("cat:") ? niche.slice(4) : niche;
}

const pct = (n: number) => `${n.toFixed(2)}%`;

// The visual core: your value plotted inside the peer distribution. The shaded
// band is the middle 50% of peers (p25–p75), the tick is the peer median, and
// the bright marker is where this shop lands.
function PeerRangeBar({ kpi, geo }: { kpi: PeerKpi; geo: BenchmarkBarGeometry }) {
  const youLabel = fmtValue(kpi, kpi.your_value);
  return (
    <div
      className="cd-bench-track"
      role="img"
      aria-label={`${kpi.label}: you ${youLabel}, peers ${fmtValue(kpi, kpi.p25)} to ${fmtValue(
        kpi,
        kpi.p75,
      )}`}
    >
      <div
        className="cd-bench-band"
        style={{ left: pct(geo.bandStartPct), width: pct(geo.bandWidthPct) }}
      />
      {geo.medianPct !== null ? (
        <div className="cd-bench-median" style={{ left: pct(geo.medianPct) }} />
      ) : null}
      {geo.youPct !== null ? (
        <div className="cd-bench-you" style={{ left: pct(geo.youPct) }}>
          <span className="cd-bench-you-dot" />
        </div>
      ) : null}
    </div>
  );
}

function KpiRow({ kpi }: { kpi: PeerKpi }) {
  const geo = benchmarkBarGeometry(kpi);
  return (
    <div className="cd-benchmark-row">
      <div className="cd-row-between">
        <span className="cd-stat-label">{kpi.label}</span>
        <span className="cd-kpi-value">{fmtValue(kpi, kpi.your_value)}</span>
      </div>
      {geo ? (
        <>
          <PeerRangeBar kpi={kpi} geo={geo} />
          <div className="cd-row-between">
            <span className="cd-caption">
              peers {fmtValue(kpi, kpi.p25)}–{fmtValue(kpi, kpi.p75)}
            </span>
            <Pill tone="accent">
              {kpi.percentile !== null
                ? `${kpi.percentile}th pct · ${kpi.n} peers`
                : `${kpi.n} peers`}
            </Pill>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PeerBenchmarks({
  data,
  defaultOpen = false,
}: {
  data: Data;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  if (data.niche === "cat:uncategorized") return null; // spec §7: card hidden

  const noneAvailable = data.kpis.every((k) => !k.available);
  return (
    <Card className="cd-benchmarks" pad={false}>
      <h2 className="cd-bench-heading">
        <button
          type="button"
          className="cd-bench-head"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="cd-bench-chevron" data-open={open ? "1" : "0"}>
            <CDIcon name="chevronRight" size={16} strokeWidth={2.2} />
          </span>
          <span className="cd-h2">Peer Benchmarks</span>
          <Pill tone="neutral">{categoryLabel(data.niche)}</Pill>
        </button>
      </h2>
      <div className="cd-collapse" data-open={open ? "1" : "0"} id={panelId}>
        <div className="cd-collapse-inner">
          {!data.consented ? (
            <span className="cd-caption">
              Share anonymized metrics to see how you compare — unlocks at 5 peers.
            </span>
          ) : noneAvailable ? (
            <span className="cd-caption">
              Benchmarks unlock when 5+ {categoryLabel(data.niche)} stores opt in.
            </span>
          ) : null}
          {data.kpis.map((kpi) => (
            <KpiRow key={kpi.metric_key} kpi={kpi} />
          ))}
        </div>
      </div>
    </Card>
  );
}
