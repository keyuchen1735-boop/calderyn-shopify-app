// Lightweight inline-SVG trend chart with an optional peer-baseline p25–p75
// band. Deliberately avoids a charting library (no recharts / chart.js / d3) so
// the bundle stays small and the surface remains Polaris-only.

import { useEffect, useRef, useState } from "react";
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
  /** Explicit width (px). When omitted, the chart fills its container. */
  width?: number;
  height?: number;
  /** Optional accessible label */
  ariaLabel?: string;
  /** Format a y value for tick labels. Defaults to whole-percent (0..1 → "NN%"). */
  formatValue?: (v: number) => string;
}

// Left padding fits up to a 4-char tick label ("3.04x") at fontSize 10;
// right padding lets the last x-tick label sit inside the chart edge.
const PADDING = { top: 16, right: 24, bottom: 28, left: 44 };
const DEFAULT_WIDTH = 720;
const MIN_WIDTH = 320;
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatTickDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const month = MONTH_SHORT[m - 1];
  if (!month || Number.isNaN(d)) return iso;
  return `${month} ${d}`;
}

export function MarginChart({
  series,
  peer = null,
  width: widthProp,
  height = 240,
  ariaLabel = "Trend over time",
  formatValue = (v: number) => `${(v * 100).toFixed(0)}%`,
}: MarginChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(
    widthProp ?? DEFAULT_WIDTH,
  );

  useEffect(() => {
    if (widthProp) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setMeasuredWidth(Math.max(MIN_WIDTH, Math.round(next)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [widthProp]);

  if (series.length === 0) {
    return (
      <Text as="p" tone="subdued">
        No data in the selected window yet.
      </Text>
    );
  }

  const width = widthProp ?? measuredWidth;
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

  const xTickIdxs = [0, Math.floor(series.length / 2), series.length - 1].filter(
    (idx, i, arr) => arr.indexOf(idx) === i,
  );

  return (
    <BlockStack gap="200">
      <div ref={containerRef} style={{ width: "100%" }}>
        <svg
          role="img"
          aria-label={ariaLabel}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: "block", width: "100%", height }}
        >
          <g transform={`translate(${PADDING.left},${PADDING.top})`}>
            {peer ? (
              <g>
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

            {/* x ticks: first / mid / last date — anchor to edge to keep labels in-bounds */}
            {xTickIdxs.map((idx, i) => (
              <text
                key={idx}
                x={xScale(idx)}
                y={innerH + 16}
                fontSize={10}
                textAnchor={
                  i === 0
                    ? "start"
                    : i === xTickIdxs.length - 1
                      ? "end"
                      : "middle"
                }
                fill="#475569"
              >
                {formatTickDate(dates[idx])}
              </text>
            ))}

            <path d={path} fill="none" stroke="#0f172a" strokeWidth={2} />
          </g>
        </svg>
      </div>
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
