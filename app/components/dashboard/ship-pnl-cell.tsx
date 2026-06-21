import { formatShipPnl } from "~/lib/ship-cost/ship-pnl";

/**
 * Inventory "Ship P&L" cell (dashboard / Calderyn surface). Net shipping P&L for
 * a SKU — green for profit, red for free-shipping bleed, muted for $0/none.
 * Mirrors the embedded Polaris cell via the shared `formatShipPnl`.
 */
export function ShipPnlCell({ cents }: { cents: number | null }) {
  const { label, tone } = formatShipPnl(cents);
  const color =
    tone === "pos"
      ? "var(--green)"
      : tone === "neg"
        ? "var(--red)"
        : "var(--text-2)";
  return (
    <span
      className="tabular-nums cd-row-num"
      style={{ color }}
      data-tone={tone}
      // A bare "—" looks like a dead column; explain why and where to fix it (P2-15).
      title={cents === null ? "Add product weights in Settings to see ship P&L" : undefined}
    >
      {label}
    </span>
  );
}
