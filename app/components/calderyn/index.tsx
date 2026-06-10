/*
 * Calderyn shared UI components.
 *
 * These recreate the bespoke pieces from the Claude Design handoff (StatTile,
 * AlertCard, GuardrailMeter, EvidencePanel, NarrativeCard, the ambient critical
 * banner, MoneyDelta) on top of real Shopify Polaris primitives. Layout and
 * color come from Polaris; only the meter bar, sparkline, and per-side accent
 * borders use the scoped styles in `calderyn.css`.
 *
 * Everything is wired to the real Calderyn data types — no mock data.
 */
import type { ReactNode } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Banner,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
  Tooltip,
} from "@shopify/polaris";
import type { Alert, DetectorId, Severity } from "~/lib/types";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import {
  DETECTOR_LABELS,
  DETECTOR_TERMS,
  EVIDENCE_FORMATTERS,
  EVIDENCE_LABELS,
} from "~/lib/labels";
import { CountUp } from "./count-up";

export { CountUp } from "./count-up";

/* ───────────────────────────── Icon ───────────────────────────── */

const ICON_PATHS: Record<string, string> = {
  spark: "M13 2L5 13h6l-1 9 8-11h-6z",
  check: "M5 12l5 5L19 7",
  x: "M6 6l12 12M18 6L6 18",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowFlat: "M5 12h14",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
};

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.7,
  fill = false,
}: {
  name: keyof typeof ICON_PATHS;
  size?: number;
  strokeWidth?: number;
  fill?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/* ───────────────────────────── MoneyDelta ───────────────────────────── */

/** A signed percentage trend chip. `invert` flags metrics where up is bad. */
export function MoneyDelta({ pct, invert = false }: { pct: number; invert?: boolean }) {
  const flat = pct === 0;
  const good = invert ? pct < 0 : pct > 0;
  const variant = flat ? "flat" : good ? "up" : "down";
  const icon = flat ? "arrowFlat" : pct > 0 ? "arrowUp" : "arrowDown";
  return (
    <span className={`cdn-delta cdn-delta--${variant}`}>
      <Icon name={icon} size={13} strokeWidth={2.2} />
      {flat ? "0%" : `${Math.abs(pct)}%`}
    </span>
  );
}

/* ───────────────────────────── Badges ───────────────────────────── */

export function severityTone(severity: Severity): "critical" | "warning" | "attention" {
  return severity === "critical" ? "critical" : severity === "high" ? "warning" : "attention";
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return <Badge tone={severityTone(severity)}>{label}</Badge>;
}

/** The plain-language detector name as a Badge, with the technical term on hover. */
export function DetectorTag({ detectorId }: { detectorId: DetectorId }) {
  return (
    <Tooltip content={DETECTOR_TERMS[detectorId]}>
      <Badge>{DETECTOR_LABELS[detectorId]}</Badge>
    </Tooltip>
  );
}

/* ───────────────────────────── StatTile ───────────────────────────── */

export function StatTile({
  label,
  value,
  tone,
  caption,
  delta,
  deltaInvert,
  onClick,
  children,
  loading,
}: {
  label: string;
  value?: string;
  tone?: "critical" | "success";
  caption?: string;
  delta?: number;
  deltaInvert?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  loading?: boolean;
}) {
  const inner = (
    <Card>
      <BlockStack gap="150">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        {loading ? (
          <BlockStack gap="200">
            <SkeletonDisplayText size="medium" />
            <SkeletonBodyText lines={1} />
          </BlockStack>
        ) : (
          <>
            {value !== undefined && (
              <InlineStack gap="200" blockAlign="baseline">
                <Text as="p" variant="heading2xl" tone={tone}>
                  <span className="cdn-tnum">
                    <CountUp value={value} />
                  </span>
                </Text>
                {delta !== undefined && <MoneyDelta pct={delta} invert={deltaInvert} />}
              </InlineStack>
            )}
            {children}
            {caption && (
              <Text as="p" variant="bodySm" tone="subdued">
                {caption}
              </Text>
            )}
          </>
        )}
      </BlockStack>
    </Card>
  );

  if (!onClick) return inner;
  return (
    <button
      type="button"
      className="cdn-tile-button"
      onClick={onClick}
      aria-label={`${label}: ${value ?? ""}`}
    >
      {inner}
    </button>
  );
}

/* ───────────────────────────── GuardrailMeter ───────────────────────────── */

export type GuardrailCheck = { label: string; ok: boolean };

export function GuardrailMeter({
  usedCents,
  totalCents,
  checks,
  compact = false,
  label = "Daily action budget",
}: {
  usedCents: number;
  totalCents: number;
  checks?: GuardrailCheck[];
  compact?: boolean;
  label?: string;
}) {
  const pct = totalCents > 0 ? Math.min(100, Math.round((usedCents / totalCents) * 100)) : 0;
  const level = pct >= 100 ? "crit" : pct >= 80 ? "warn" : "ok";
  return (
    <BlockStack gap="200">
      <InlineStack align={compact ? "end" : "space-between"} blockAlign="baseline">
        {!compact && (
          <Text as="span" variant="bodySm" tone="subdued">
            {label}
          </Text>
        )}
        <Text as="span" variant="bodySm" fontWeight="semibold">
          <span className="cdn-tnum">
            {fmtMoney(usedCents)} / {fmtMoney(totalCents)}
          </span>
        </Text>
      </InlineStack>
      <div className="cdn-meter-track">
        <div
          className={`cdn-meter-fill cdn-meter-fill--${level}`}
          style={{ transform: `scaleX(${Math.max(0.01, pct / 100)})` }}
        />
      </div>
      {!compact && checks && checks.length > 0 && (
        <BlockStack gap="150">
          {checks.map((c) => (
            <InlineStack key={c.label} gap="200" blockAlign="center" wrap={false}>
              <span className={`cdn-check ${c.ok ? "cdn-check--ok" : "cdn-check--no"}`}>
                <Icon name={c.ok ? "check" : "x"} size={11} strokeWidth={2.6} />
              </span>
              <Text as="span" variant="bodySm" tone={c.ok ? undefined : "critical"}>
                {c.label}
              </Text>
            </InlineStack>
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}

/* ───────────────────────────── AlertCard ───────────────────────────── */

export function AlertCard({
  alert,
  onReview,
  compact = false,
}: {
  alert: Alert;
  onReview: (alert: Alert) => void;
  compact?: boolean;
}) {
  return (
    <Box background="bg-surface" borderColor="border" borderWidth="025" borderRadius="300" padding="400">
      <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
        <BlockStack gap="150">
          <InlineStack gap="150" blockAlign="center">
            <SeverityBadge severity={alert.severity} />
            <DetectorTag detectorId={alert.detector_id} />
            <Text as="span" variant="bodySm" tone="subdued">
              {fmtRelTime(alert.created_at)}
            </Text>
          </InlineStack>
          <Button variant="monochromePlain" textAlign="left" onClick={() => onReview(alert)}>
            {alert.title}
          </Button>
        </BlockStack>
        <InlineStack gap="400" blockAlign="center" wrap={false}>
          <BlockStack gap="050" inlineAlign="end">
            <Text as="span" variant="bodyXs" tone="subdued">
              30-DAY
            </Text>
            <Text as="span" variant="headingMd" tone="critical">
              <span className="cdn-tnum">{fmtMoney(alert.dollar_impact)}</span>
            </Text>
          </BlockStack>
          {!compact && (
            <Button onClick={() => onReview(alert)} accessibilityLabel={`Review: ${alert.title}`}>
              Review
            </Button>
          )}
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

/* ───────────────────────────── NarrativeCard ───────────────────────────── */

export function NarrativeCard({ rank, children }: { rank?: number; children: ReactNode }) {
  return (
    <div className="cdn-card cdn-accent-left cdn-accent-left--info">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="150" blockAlign="center">
            <span style={{ color: "var(--cdn-info)", display: "inline-flex" }}>
              <Icon name="spark" size={16} fill />
            </span>
            <Text as="h2" variant="headingSm">
              The take
            </Text>
          </InlineStack>
          {rank !== undefined && <Badge tone="info">{`Rank #${rank}`}</Badge>}
        </InlineStack>
        <Text as="p" variant="bodyLg">
          {children}
        </Text>
      </BlockStack>
    </div>
  );
}

/* ───────────────────────────── EvidencePanel ───────────────────────────── */

function prettyKey(k: string) {
  if (EVIDENCE_LABELS[k]) return EVIDENCE_LABELS[k];
  const s = k.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 1 && v.every((n) => typeof n === "number");
}

function Sparkline({ values, tone = "info" }: { values: number[]; tone?: "info" | "critical" }) {
  const W = 280;
  const H = 40;
  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (W - pad * 2) / (values.length - 1) : 0;
  const pts = values.map(
    (v, i) => `${(pad + i * step).toFixed(1)},${(H - pad - ((v - min) / span) * (H - pad * 2)).toFixed(1)}`,
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cdn-spark" role="img" aria-label="Trend">
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={tone === "critical" ? "var(--cdn-critical)" : "var(--cdn-info)"}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function evidenceValueToString(key: string, v: unknown): string {
  const formatter = EVIDENCE_FORMATTERS[key];
  if (formatter) return formatter(v);
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function EvidencePanel({
  evidence,
  hideKeys = [],
}: {
  evidence: Record<string, unknown>;
  /** Evidence keys to suppress (e.g. ones already shown in the page header). */
  hideKeys?: string[];
}) {
  const skipSet = new Set(hideKeys);
  const entries = Object.entries(evidence ?? {}).filter(([k]) => !skipSet.has(k));
  if (entries.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        No structured evidence on this alert yet.
      </Text>
    );
  }
  const series = entries.filter(([, v]) => isNumberArray(v)) as [string, number[]][];
  const scalars = entries.filter(([, v]) => !isNumberArray(v));
  return (
    <BlockStack gap="300">
      {series.map(([k, values]) => (
        <Box key={k} background="bg-surface-secondary" borderRadius="200" padding="300">
          <BlockStack gap="150">
            <Text as="p" variant="bodyXs" tone="subdued">
              {prettyKey(k)}
            </Text>
            <Sparkline values={values} />
          </BlockStack>
        </Box>
      ))}
      {scalars.length > 0 && (
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
          {scalars.map(([k, v]) => (
            <Box key={k} background="bg-surface-secondary" borderRadius="200" padding="300">
              <BlockStack gap="050">
                <Text as="p" variant="bodyXs" tone="subdued">
                  {prettyKey(k)}
                </Text>
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  <span className="cdn-tnum">{evidenceValueToString(k, v)}</span>
                </Text>
              </BlockStack>
            </Box>
          ))}
        </InlineGrid>
      )}
    </BlockStack>
  );
}

/* ───────────────────────────── AmbientAlertBanner ───────────────────────────── */

export function AmbientAlertBanner({
  criticalCount,
  atRiskCents,
  onReview,
  onDismiss,
}: {
  criticalCount: number;
  atRiskCents: number;
  onReview: () => void;
  onDismiss?: () => void;
}) {
  if (criticalCount <= 0) return null;
  const title = `${criticalCount} critical alert${criticalCount > 1 ? "s" : ""} · ${fmtMoney(
    atRiskCents,
  )}/mo at risk`;
  return (
    <Banner
      tone="critical"
      title={title}
      action={{ content: "Review", onAction: onReview }}
      onDismiss={onDismiss}
    >
      <Text as="p" variant="bodySm">
        Calderyn flagged spend leaking into products you can&apos;t profitably sell. Review and act
        before it compounds.
      </Text>
    </Banner>
  );
}
