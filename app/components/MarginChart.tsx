// Lightweight inline-SVG trend chart with an optional peer-baseline p25–p75
// band. Deliberately avoids a charting library (no recharts / chart.js / d3) so
// the bundle stays small and the surface remains Polaris-only.

import { Text, BlockStack, InlineStack } from "@shopify/polaris";

export interface MarginPoint {
  date: string; // ISO yyyy-mm-dd
  margin_pct: number; // 0..1 (or any ratio when a custom formatValue is given)
}

export interface PeerBand {
  p25: number;
  p50?: number | null;
  p75: number;
  bucket_size: number;
}

export interface MarginChartProps {
  series: MarginPoint[];
  peer?: PeerBand | null;
  width?: number;
  height?: number;
  /** Optional accessible label */
  ariaLabel?: string;
  /** Format a y value for tick labels. Defaults to whole-percent (0..1 → "NN%"). */
  formatValue?: (v: number) => string;
}

const PADDING = { top: 16, right: 16, bottom: 24, left: 32 };

export function MarginChart({
  series,
  peer = null,
  width = 720,
  height = 240,
  ariaLabel = "Trend over time",
  formatValue = (v: number) => `${(v * 100).toFixed(0)}%`,
}: MarginChartProps) {
  if (series.length === 0) {
    return (
      <Text as="p" tone="subdued">
        No data in the selected window yet.
      </Text>
    );
  }

  const innerW = width - PADDING.left - PADDING.right;
  const innerH = height - PADDING.top - PADDING.bottom;

  const dates = series.map((p) => p.date);
  const ys = series.map((p) => p.margin_pct);

  const minY = Math.min(...ys, peer ? peer.p25 : Infinity);
  const maxY = Math.max(...ys, peer ? peer.p75 : -Infinity);
  const yPad = Math.max(0.02, (maxY - minY) * 0.1);
  const yMin = Math.max(0, minY - yPad);
  const yMax = maxY + yPad;

  const xScale = (i: number) =>
    series.length === 1 ? 0 : (i / (series.length - 1)) * innerW;
  const yScale = (v: number) =>
    innerH - ((v - yMin) / Math.max(0.0001, yMax - yMin)) * innerH;

  const path = series
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(1)} ${yScale(p.margin_pct).toFixed(1)}`,
    )
    .join(" ");

  const peerY1 = peer ? yScale(peer.p75) : 0;
  const peerY2 = peer ? yScale(peer.p25) : 0;

  return (
    <BlockStack gap="200">
      <svg
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ maxWidth: "100%" }}
      >
        <g transform={`translate(${PADDING.left},${PADDING.top})`}>
          {peer ? (
            <g data-testid="peer-band">
              <rect
                x={0}
                y={Math.min(peerY1, peerY2)}
                width={innerW}
                height={Math.abs(peerY2 - peerY1)}
                fill="#4f46e5"
                fillOpacity={0.12}
              />
              {peer.p50 !== null && peer.p50 !== undefined ? (
                <line
                  x1={0}
                  y1={yScale(peer.p50)}
                  x2={innerW}
                  y2={yScale(peer.p50)}
                  stroke="#4f46e5"
                  strokeOpacity={0.5}
                  strokeDasharray="4 4"
                />
              ) : null}
            </g>
          ) : null}

          {/* axes */}
          <line x1={0} y1={innerH} x2={innerW} y2={innerH} stroke="#cbd5e1" />
          <line x1={0} y1={0} x2={0} y2={innerH} stroke="#cbd5e1" />

          {/* y ticks at min/mid/max */}
          {[yMin, (yMin + yMax) / 2, yMax].map((v, i) => (
            <g key={i} transform={`translate(0,${yScale(v)})`}>
              <line
                x1={-4}
                x2={innerW}
                y1={0}
                y2={0}
                stroke="#e2e8f0"
                strokeDasharray="2 4"
              />
              <text x={-8} y={4} fontSize={10} textAnchor="end" fill="#475569">
                {formatValue(v)}
              </text>
            </g>
          ))}

          {/* x ticks: first / mid / last date */}
          {[0, Math.floor(series.length / 2), series.length - 1]
            .filter((idx, i, arr) => arr.indexOf(idx) === i)
            .map((idx) => (
              <text
                key={idx}
                x={xScale(idx)}
                y={innerH + 16}
                fontSize={10}
                textAnchor="middle"
                fill="#475569"
              >
                {dates[idx]}
              </text>
            ))}

          <path d={path} fill="none" stroke="#0f172a" strokeWidth={2} />
        </g>
      </svg>
      {peer ? (
        <InlineStack gap="200">
          <Text as="span" tone="subdued">
            Peer band p25–p75 across {peer.bucket_size} similar shops.
          </Text>
        </InlineStack>
      ) : null}
    </BlockStack>
  );
}
