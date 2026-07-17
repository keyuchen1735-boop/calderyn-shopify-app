export interface ProductContributionInput {
  id: string;
  netRevenueCents: number;
  contributionCents: number;
}

export interface AllocatedProductContribution extends ProductContributionInput {
  allocatedOperatingExpensesCents: number;
  netOperatingProfitCents: number;
}

export interface StatementRow {
  label: string;
  cents: number;
  depth: number;
  total: boolean;
  section?: boolean;
}

export interface ParsedQuickBooksReport {
  incomeCents: number;
  cogsCents: number;
  operatingExpensesCents: number;
  netIncomeCents: number;
  rows: StatementRow[];
  daily: Array<{ date: string; netIncomeCents: number }>;
}

export interface OperatingPnlProduct extends AllocatedProductContribution {
  title: string;
  sku: string | null;
  imageUrl: string | null;
  cogsCents: number;
  netMarginPct: number | null;
}

export interface OperatingPnlData {
  connected: boolean;
  currency: string;
  startDate: string;
  endDate: string;
  statement: ParsedQuickBooksReport | null;
  netCashFlowCents: number | null;
  products: OperatingPnlProduct[];
}

type Col = { value?: unknown };
type ReportRow = {
  ColData?: Col[];
  Header?: { ColData?: Col[] };
  Summary?: { ColData?: Col[] };
  Rows?: { Row?: ReportRow[] };
};

function text(col: Col | undefined): string {
  return typeof col?.value === "string" ? col.value.trim() : "";
}

function cents(col: Col | undefined): number {
  const value = Number(text(col).replaceAll(",", ""));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function values(cols: Col[] | undefined): number[] {
  return (cols ?? []).slice(1).map(cents);
}

function sum(xs: number[]): number {
  return xs.reduce((total, value) => total + value, 0);
}

export function parseQuickBooksReport(raw: unknown): ParsedQuickBooksReport {
  const report = raw as {
    Columns?: { Column?: Array<{ ColTitle?: unknown }> };
    Rows?: { Row?: ReportRow[] };
  };
  const columns = report.Columns?.Column ?? [];
  const valueTitles = columns.slice(1).map((column) =>
    typeof column.ColTitle === "string" ? column.ColTitle.trim() : "",
  );
  const periodTotal = (amounts: number[]): number => {
    const totalIndex = valueTitles.findIndex((title) => title.toLowerCase() === "total");
    return totalIndex >= 0 ? amounts[totalIndex] ?? 0 : sum(amounts);
  };
  const rows: StatementRow[] = [];
  const totals = new Map<string, number[]>();

  function walk(items: ReportRow[] | undefined, depth: number): void {
    for (const row of items ?? []) {
      const headerLabel = text(row.Header?.ColData?.[0]);
      if (headerLabel) rows.push({ label: headerLabel, cents: 0, depth, total: false, section: true });
      const detailLabel = text(row.ColData?.[0]);
      if (detailLabel) {
        const amount = periodTotal(values(row.ColData));
        rows.push({ label: detailLabel, cents: amount, depth: depth + 1, total: false });
      }
      walk(row.Rows?.Row, depth + 1);
      const totalLabel = text(row.Summary?.ColData?.[0]);
      if (totalLabel) {
        const amounts = values(row.Summary?.ColData);
        totals.set(totalLabel.toLowerCase(), amounts);
        rows.push({ label: totalLabel, cents: periodTotal(amounts), depth, total: true });
      }
    }
  }
  walk(report.Rows?.Row, 0);

  const total = (...labels: string[]): number[] => {
    for (const label of labels) {
      const match = totals.get(label.toLowerCase());
      if (match) return match;
    }
    return [];
  };
  const income = total("Total Income");
  const cogs = total("Total Cost of Goods Sold", "Total COGS");
  const expenses = total("Total Expenses", "Total Operating Expenses");
  const net = total("Net Income", "Net Operating Income");
  const dates = valueTitles.map((title) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(title)) return title;
    const parsed = Date.parse(title);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
  });

  return {
    incomeCents: periodTotal(income),
    cogsCents: periodTotal(cogs),
    operatingExpensesCents: periodTotal(expenses),
    netIncomeCents: periodTotal(net),
    rows,
    daily: dates.flatMap((date, index) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? [{ date, netIncomeCents: net[index] ?? 0 }]
        : [],
    ),
  };
}

export function parseQuickBooksCashFlow(raw: unknown): number {
  const report = raw as { Rows?: { Row?: ReportRow[] } };
  let fallback = 0;
  let result: number | null = null;
  function walk(items: ReportRow[] | undefined): void {
    for (const row of items ?? []) {
      walk(row.Rows?.Row);
      const cols = row.Summary?.ColData ?? row.ColData;
      const label = text(cols?.[0]).toLowerCase();
      const amount = sum(values(cols));
      if (label.includes("net cash provided by operating activities")) fallback = amount;
      if (label.includes("net increase in cash") || label.includes("net change in cash")) result = amount;
    }
  }
  walk(report.Rows?.Row);
  return result ?? fallback;
}

export function allocateOperatingExpenses<T extends ProductContributionInput>(
  products: T[],
  operatingExpensesCents: number,
): Array<T & AllocatedProductContribution> {
  const revenue = products.reduce((total, product) => total + Math.max(0, product.netRevenueCents), 0);
  let allocated = 0;
  return products.map((product, index) => {
    const amount = index === products.length - 1
      ? operatingExpensesCents - allocated
      : revenue === 0
        ? 0
        : Math.round(operatingExpensesCents * Math.max(0, product.netRevenueCents) / revenue);
    allocated += amount;
    return {
      ...product,
      allocatedOperatingExpensesCents: amount,
      netOperatingProfitCents: product.contributionCents - amount,
    };
  });
}
