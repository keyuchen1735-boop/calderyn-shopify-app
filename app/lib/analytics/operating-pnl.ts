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

export interface OperatingPnlProductInput extends ProductContributionInput {
  title: string;
  sku: string | null;
  imageUrl: string | null;
  cogsCents: number;
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
    // With no revenue to weight against, there is no basis to attribute the
    // expense — leave every product at 0 rather than dumping the whole amount
    // on whichever product happens to be last.
    const amount = revenue === 0
      ? 0
      : index === products.length - 1
        ? operatingExpensesCents - allocated
        : Math.round(operatingExpensesCents * Math.max(0, product.netRevenueCents) / revenue);
    allocated += amount;
    return {
      ...product,
      allocatedOperatingExpensesCents: amount,
      netOperatingProfitCents: product.contributionCents - amount,
    };
  });
}

export function buildOperatingPnlProducts(
  products: OperatingPnlProductInput[],
  statement: Pick<ParsedQuickBooksReport, "incomeCents" | "cogsCents" | "netIncomeCents">,
): OperatingPnlProduct[] {
  const belowGrossCostsCents = statement.incomeCents - statement.cogsCents - statement.netIncomeCents;
  const inputs = [...products];
  const productRevenue = inputs.reduce((sum, row) => sum + row.netRevenueCents, 0);
  const productCogs = inputs.reduce((sum, row) => sum + row.cogsCents, 0);
  const netRevenueCents = statement.incomeCents - productRevenue;
  const cogsCents = statement.cogsCents - productCogs;

  if (netRevenueCents !== 0 || cogsCents !== 0) {
    inputs.push({
      id: "quickbooks-unattributed",
      title: "Unattributed QuickBooks activity",
      sku: null,
      imageUrl: null,
      netRevenueCents,
      cogsCents,
      contributionCents: netRevenueCents - cogsCents,
    });
  }

  const allocated = allocateOperatingExpenses(inputs, belowGrossCostsCents);
  const profitGap = statement.netIncomeCents
    - allocated.reduce((sum, row) => sum + row.netOperatingProfitCents, 0);
  if (profitGap !== 0) {
    const row = allocated.find((product) => product.id === "quickbooks-unattributed");
    if (row) {
      row.allocatedOperatingExpensesCents -= profitGap;
      row.netOperatingProfitCents += profitGap;
    } else {
      allocated.push({
        id: "quickbooks-unattributed",
        title: "Unattributed QuickBooks activity",
        sku: null,
        imageUrl: null,
        netRevenueCents: 0,
        cogsCents: 0,
        contributionCents: 0,
        allocatedOperatingExpensesCents: -profitGap,
        netOperatingProfitCents: profitGap,
      });
    }
  }

  return allocated.map((product) => ({
    ...product,
    netMarginPct: product.netRevenueCents === 0
      ? null
      : product.netOperatingProfitCents / product.netRevenueCents * 100,
  })).sort((a, b) => b.netOperatingProfitCents - a.netOperatingProfitCents);
}
