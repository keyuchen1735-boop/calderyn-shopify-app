// Spend-weighted, margin-adjusted blended ROAS — the "true" return on ad spend.
// Shared by the embedded admin home (app/routes/app._index.tsx) and the web
// dashboard's stat row (app/components/dashboard/screens/Dashboard.tsx) so the
// two surfaces can never disagree on the number.

export interface TrueRoasInput {
  spend_7d: number;
  roas_7d: number;
  contribution_margin: number;
}

export function trueRoas(campaigns: TrueRoasInput[]): string {
  // margin < 0 is a real money-loser and must count (it drags the blend down);
  // margin === 0 is the "no margin data" sentinel (calderyn.server coerces a
  // missing margin to 0) and stays excluded. Without this, the headline number
  // read rosier than reality precisely when campaigns were losing money.
  const withData = campaigns.filter(
    (c) => c.spend_7d > 0 && c.roas_7d > 0 && c.contribution_margin !== 0,
  );
  const totalSpend = withData.reduce((s, c) => s + c.spend_7d, 0);
  if (totalSpend === 0) return "—";
  const weighted = withData.reduce(
    (s, c) => s + c.spend_7d * c.roas_7d * c.contribution_margin,
    0,
  );
  return `${(weighted / totalSpend).toFixed(1)}×`;
}
