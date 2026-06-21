// Read-only calibration headline for the embedded dashboard. Display only -
// no actions, no autonomy. The number comes from shops.calibration_pct via
// the nightly recompute.
import { Badge, BlockStack, Card, InlineStack, ProgressBar, Text } from "@shopify/polaris";
import type { Calibration } from "../../lib/types";

export function calibrationLabel(pct: number | null): string {
  if (pct == null) return "Calibrating your agent";
  if (pct >= 90) return "Nearly autonomous";
  if (pct >= 50) return "Learning fast";
  return "Getting started";
}

export default function CalibrationHeader({ calibration }: { calibration: Calibration }) {
  const pct = calibration.pct;
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Calderyn Calibration
          </Text>
          <Badge tone={pct != null && pct >= 50 ? "success" : "attention"}>
            {pct == null ? "Warming up" : `${pct}%`}
          </Badge>
        </InlineStack>
        <ProgressBar progress={pct ?? 0} size="small" tone="highlight" />
        <Text as="p" tone="subdued" variant="bodySm">
          {calibrationLabel(pct)}. As you approve or reject what Calderyn suggests, it learns
          your shop and this number climbs toward 100% (fully hands-off).
        </Text>
      </BlockStack>
    </Card>
  );
}
