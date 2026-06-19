// Shared display helpers for a campaign row, used by both the desktop DataTable
// and the mobile card list (app/routes/app.campaigns._index.tsx) so the two
// surfaces render the same labels. Pure + framework-free → unit-tested.
import { fmtMoney } from "./format";

/** A campaign's 7-day ROAS: one decimal with a × suffix, or "—" when there is
 *  no meaningful return (0 or negative — e.g. no revenue yet, or paused). */
export function campaignRoasLabel(roas: number): string {
  return roas > 0 ? `${roas.toFixed(1)}×` : "—";
}

/** A campaign's daily budget: the formatted money for an active campaign, or
 *  "—" when paused (a paused campaign isn't spending its stored budget). */
export function campaignBudgetLabel(
  status: "active" | "paused",
  dailyBudgetCents: number,
): string {
  return status === "paused" ? "—" : fmtMoney(dailyBudgetCents);
}
