export interface ParsedInvoiceRow {
  orderRef: string | null;
  trackingNo: string | null;
  costCents: number;
}

export interface ParseError {
  /** 1-based source line, or 0 for a header-level error. */
  line: number;
  reason: string;
}

export interface ParseResult {
  rows: ParsedInvoiceRow[];
  errors: ParseError[];
}

const ORDER_KEYS = ["order", "order#", "order_no", "order number", "order_number", "name"];
const TRACKING_KEYS = ["tracking", "tracking#", "tracking_no", "tracking number", "tracking_number"];
const COST_KEYS = ["cost", "amount", "charge", "total", "price"];

function splitCsvLine(line: string): string[] {
  // Minimal CSV: handles quoted fields with embedded commas; no escaped quotes.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function findIndex(header: string[], keys: string[]): number {
  return header.findIndex((h) => keys.includes(h.toLowerCase()));
}

function parseCost(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function parseInvoiceCsv(text: string): ParseResult {
  const rows: ParsedInvoiceRow[] = [];
  const errors: ParseError[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return { rows, errors: [{ line: 0, reason: "empty file" }] };
  }
  const header = splitCsvLine(lines[0]);
  const orderIdx = findIndex(header, ORDER_KEYS);
  const trackingIdx = findIndex(header, TRACKING_KEYS);
  const costIdx = findIndex(header, COST_KEYS);
  if (costIdx === -1) {
    return { rows, errors: [{ line: 0, reason: "missing required cost column" }] };
  }
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const orderRef = orderIdx >= 0 ? cells[orderIdx] || "" : "";
    const trackingNo = trackingIdx >= 0 ? cells[trackingIdx] || "" : "";
    if (!orderRef && !trackingNo) {
      errors.push({ line: i + 1, reason: "row has neither order ref nor tracking number" });
      continue;
    }
    const costCents = parseCost(cells[costIdx] ?? "");
    if (costCents === null) {
      errors.push({ line: i + 1, reason: `unparseable cost "${cells[costIdx] ?? ""}"` });
      continue;
    }
    rows.push({
      orderRef: orderRef || null,
      trackingNo: trackingNo || null,
      costCents,
    });
  }
  return { rows, errors };
}
