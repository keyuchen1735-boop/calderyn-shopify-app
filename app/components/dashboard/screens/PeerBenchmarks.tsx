import { Card, Meter, Pill } from "~/components/dashboard/ui";
import type { PeerBenchmarks as Data, PeerKpi } from "~/lib/benchmarks/types";

function fmtValue(kpi: PeerKpi, v: number | null): string {
  if (v === null) return "—";
  return kpi.unit === "USD" ? `$${v.toFixed(2)}` : `${(v * 100).toFixed(1)}%`;
}

function categoryLabel(niche: string): string {
  return niche.startsWith("cat:") ? niche.slice(4) : niche;
}

function KpiRow({ kpi }: { kpi: PeerKpi }) {
  return (
    <div className="cd-benchmark-row">
      <div className="cd-row-between">
        <span className="cd-stat-label">{kpi.label}</span>
        <span className="cd-stat-value tabular-nums">{fmtValue(kpi, kpi.your_value)}</span>
      </div>
      {kpi.available ? (
        <>
          {kpi.percentile !== null ? <Meter pct={kpi.percentile} tone="accent" /> : null}
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

export function PeerBenchmarks({ data }: { data: Data }) {
  if (data.niche === "cat:uncategorized") return null; // spec §7: card hidden

  const noneAvailable = data.kpis.every((k) => !k.available);
  return (
    <Card className="cd-benchmarks">
      <div className="cd-row-between">
        <h2 className="cd-h2">Peer Benchmarks</h2>
        <Pill tone="neutral">{categoryLabel(data.niche)}</Pill>
      </div>
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
    </Card>
  );
}
