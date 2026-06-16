// Shared formatter for the per-SKU net shipping P&L shown in the Inventory
// "Ship P&L" column on both surfaces (embedded Polaris + Calderyn dashboard).
// Owns the signed whole-dollar label so both surfaces render identically; each
// surface maps the neutral tone token to its own visual tone.

export type ShipPnlTone = "pos" | "neg" | "zero";

export interface ShipPnl {
  label: string;
  tone: ShipPnlTone;
}

/**
 * Format a net shipping P&L (cents: shipping collected − true ship cost) for
 * display. Whole dollars, signed, with the magnitude rounded symmetrically
 * across sign (plain Math.round biases halves toward +Infinity, which would
 * understate losses and overstate gains). `null` — no in-window order with a
 * resolved ship cost — renders as a no-data dash `—`, distinct from a genuine
 * break-even (and sub-dollar magnitudes) which render as `$0`.
 */
export function formatShipPnl(cents: number | null): ShipPnl {
  if (cents == null || !Number.isFinite(cents)) return { label: "—", tone: "zero" };
  const dollars = Math.sign(cents) * Math.round(Math.abs(cents) / 100);
  if (dollars === 0) return { label: "$0", tone: "zero" };
  const abs = Math.abs(dollars).toLocaleString("en-US");
  return dollars > 0
    ? { label: `+$${abs}`, tone: "pos" }
    : { label: `-$${abs}`, tone: "neg" };
}
