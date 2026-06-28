// Shared predictive scorecard UI for a single screened creative. Pure render —
// imports NO `.server` module. Used by per-ad scorecards on the campaign detail page.
import { useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  Divider,
  InlineGrid,
  InlineStack,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import {
  METRIC_GROUPS,
  METRIC_GROUP_LABELS,
  normalizeTip,
  type Grade,
  type MetricGroup,
  type ScoreCard,
  type Tip,
} from "~/lib/screener/types";

const gradeTone: Record<Grade, "success" | "warning" | "critical"> = {
  winning: "success",
  okay: "warning",
  poor: "critical",
};

// One improvement tip: concise title; the product-specific detail expands on click.
function TipItem({ tip, index }: { tip: Tip; index: number }) {
  const t = normalizeTip(tip);
  const [open, setOpen] = useState(false);
  const expandable = t.detail.length > 0;
  const panelId = `scorecard-tip-${index}`;
  return (
    <BlockStack gap="100">
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            flexShrink: 0,
            background: "var(--p-color-bg-surface-secondary)",
            color: "var(--p-color-text-emphasis)",
            fontSize: 11.5,
            fontWeight: 650,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {index + 1}
        </span>
        {expandable ? (
          <Button
            variant="plain"
            textAlign="left"
            disclosure={open ? "up" : "down"}
            ariaExpanded={open}
            ariaControls={panelId}
            onClick={() => setOpen((o) => !o)}
          >
            {t.title}
          </Button>
        ) : (
          <Text as="span" variant="bodySm">
            {t.title}
          </Text>
        )}
      </InlineStack>
      {expandable && (
        <Collapsible id={panelId} open={open}>
          <Box paddingInlineStart="600" paddingBlockEnd="100">
            <Text as="p" variant="bodySm" tone="subdued">
              {t.detail}
            </Text>
          </Box>
        </Collapsible>
      )}
    </BlockStack>
  );
}

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (frac: number) => `${(frac * 100).toFixed(1)}%`;

function MetricRow({ m }: { m: ScoreCard["metrics"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
        style={{ cursor: "pointer" }}
        aria-expanded={open}
      >
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm">
            {open ? "▾" : "▸"} {m.label}
          </Text>
          <Text as="span" variant="bodySm" fontWeight="semibold">
            {m.score}
          </Text>
        </InlineStack>
        <Box paddingBlockStart="100">
          <ProgressBar progress={m.score} size="small" />
        </Box>
      </div>
      <Collapsible open={open} id={`metric-${m.id}`}>
        <Box paddingBlockStart="200" paddingInlineStart="200">
          <Text as="p" variant="bodySm" tone="subdued">
            {m.reasoning || "No reasoning provided."}
          </Text>
          {m.benchmarkAds && m.benchmarkAds.length > 0 && (
            <Text as="p" variant="bodySm" tone="subdued">
              Compared against: {m.benchmarkAds.join(", ")}
            </Text>
          )}
        </Box>
      </Collapsible>
    </Box>
  );
}

export function Scorecard({ card }: { card: ScoreCard }) {
  return (
    <>
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <InlineStack gap="300" blockAlign="center">
              <Text as="span" variant="heading2xl">
                {card.composite}
              </Text>
              <BlockStack gap="100">
                <Badge tone={gradeTone[card.grade]}>{card.grade}</Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  Confidence: {card.confidence}
                  {card.confidence === "low" ? " — not SKU-calibrated" : ""}
                </Text>
              </BlockStack>
            </InlineStack>
          </InlineStack>
          <Text as="p" tone="subdued">
            {card.summary}
          </Text>
          {card.confidence === "low" && (
            <Banner tone="warning" title="Low-confidence estimate">
              <p>
                This creative isn't mapped to a SKU with enough history, so outcomes use
                category/account fallbacks. Treat the numbers as directional.
              </p>
            </Banner>
          )}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingSm">
            Predicted outcomes
          </Text>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            <Box>
              <Text as="span" variant="bodySm" tone="subdued">
                Estimated ROAS
              </Text>
              <Text as="p" variant="headingLg">
                {card.outcomes.estimatedRoas}x
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                range {card.outcomes.roasLow}–{card.outcomes.roasHigh}x · break-even{" "}
                {card.outcomes.breakEvenRoas}x
              </Text>
            </Box>
            <Box>
              <Text as="span" variant="bodySm" tone="subdued">
                Predicted CTR
              </Text>
              <Text as="p" variant="headingLg">
                {pct(card.outcomes.predictedCtr)}
              </Text>
            </Box>
            <Box>
              <Text as="span" variant="bodySm" tone="subdued">
                Hold / engagement
              </Text>
              <Text as="p" variant="headingLg">
                {pct(card.outcomes.holdRate)}
              </Text>
            </Box>
          </InlineGrid>
          <Text as="span" variant="bodySm" tone="subdued">
            Based on{" "}
            {card.outcomes.mappedSku ? `SKU ${card.outcomes.mappedSku}` : "no mapped SKU"}
            {card.outcomes.skuPriceCents
              ? ` @ ${dollars(card.outcomes.skuPriceCents)}`
              : ""}{" "}
            · assumed spend {dollars(card.outcomes.assumedSpendCents)} · projected revenue{" "}
            {dollars(card.outcomes.predictedRevenueCents)}
          </Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingSm">
            Creative breakdown
          </Text>
          {METRIC_GROUPS.map((g: MetricGroup) => {
            const rows = card.metrics.filter((m) => m.group === g);
            if (rows.length === 0) return null;
            return (
              <BlockStack key={g} gap="200">
                <Text as="h3" variant="headingXs">
                  {METRIC_GROUP_LABELS[g]}
                </Text>
                {rows.map((m) => (
                  <MetricRow key={m.id} m={m} />
                ))}
                <Divider />
              </BlockStack>
            );
          })}
        </BlockStack>
      </Card>

      {card.tips.length > 0 && (
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingSm">
              How to make it better
            </Text>
            <BlockStack gap="150">
              {card.tips.map((t, i) => (
                <TipItem key={i} tip={t} index={i} />
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      )}
    </>
  );
}
