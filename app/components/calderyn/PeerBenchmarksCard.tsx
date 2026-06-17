import { Badge, BlockStack, Card, InlineStack, Text } from "@shopify/polaris";
import type { PeerBenchmarks, PeerKpi } from "~/lib/benchmarks/types";

function fmtValue(kpi: PeerKpi, v: number | null): string {
  if (v === null) return "—";
  if (kpi.unit === "USD") return `$${v.toFixed(2)}`;
  return `${(v * 100).toFixed(1)}%`;
}

function categoryLabel(niche: string): string {
  return niche.startsWith("cat:") ? niche.slice(4) : niche;
}

/** Peer band p25–p75 with the store's marker at its percentile position.
 * Reuses the dashboard's `cdn-meter-track` styling (custom CSS). */
function PeerBand({ kpi }: { kpi: PeerKpi }) {
  if (!kpi.available || kpi.percentile === null) return null;
  return (
    <div className="cdn-meter-track" style={{ position: "relative" }}>
      <div
        className="cdn-meter-fill"
        style={{ transform: "scaleX(0.5)", transformOrigin: "left", opacity: 0.25 }}
      />
      <span
        aria-label={`${kpi.percentile}th percentile`}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${kpi.percentile}%`,
          width: 2,
          background: "var(--p-color-text)",
        }}
      />
    </div>
  );
}

function KpiRow({ kpi }: { kpi: PeerKpi }) {
  return (
    <BlockStack gap="150">
      <InlineStack align="space-between" blockAlign="baseline">
        <Text as="span" variant="bodySm" tone="subdued">
          {kpi.label}
        </Text>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          <span className="cdn-tnum">{fmtValue(kpi, kpi.your_value)}</span>
        </Text>
      </InlineStack>
      {kpi.available ? (
        <>
          <PeerBand kpi={kpi} />
          <InlineStack align="space-between">
            <Text as="span" variant="bodySm" tone="subdued">
              peers {fmtValue(kpi, kpi.p25)}–{fmtValue(kpi, kpi.p75)}
            </Text>
            <Badge>{`${kpi.percentile}th pct · ${kpi.n} peers`}</Badge>
          </InlineStack>
        </>
      ) : null}
    </BlockStack>
  );
}

export function PeerBenchmarksCard({ data }: { data: PeerBenchmarks }) {
  if (data.niche === "cat:uncategorized") return null; // spec §7: card hidden

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Peer Benchmarks
          </Text>
          <Badge tone="info">{categoryLabel(data.niche)}</Badge>
        </InlineStack>

        {!data.consented ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Share anonymized metrics to see how you compare — unlocks at 5 peers.
          </Text>
        ) : data.kpis.every((k) => !k.available) ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Benchmarks unlock when 5+ {categoryLabel(data.niche)} stores opt in.
          </Text>
        ) : null}

        <BlockStack gap="400">
          {data.kpis.map((kpi) => (
            <KpiRow key={kpi.metric_key} kpi={kpi} />
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
