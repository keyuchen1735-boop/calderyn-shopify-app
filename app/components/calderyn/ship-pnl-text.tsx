import { Text } from "@shopify/polaris";

import { formatShipPnl, type ShipPnlTone } from "~/lib/ship-cost/ship-pnl";

const POLARIS_TONE: Record<ShipPnlTone, "success" | "critical" | "subdued"> = {
  pos: "success",
  neg: "critical",
  zero: "subdued",
};

/**
 * Inventory "Ship P&L" cell (embedded admin / Polaris). Net shipping P&L for a
 * SKU — success (profit) / critical (free-shipping bleed) / subdued ($0/none).
 * Mirrors the dashboard cell via the shared `formatShipPnl`.
 */
export function ShipPnlText({ cents }: { cents: number | null }) {
  const { label, tone } = formatShipPnl(cents);
  return (
    <Text as="span" tone={POLARIS_TONE[tone]} numeric>
      {label}
    </Text>
  );
}
