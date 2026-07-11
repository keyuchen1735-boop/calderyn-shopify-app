// Filtered CSV export (Phase 2 Task 4): accepts the SAME query params as the unified orders list
// route (dashboard.api.orders.list.tsx) via the shared parseOrdersListParams helper, then loops
// listOrdersUnified in PostgREST-clamped 1000-row pages until a short page or the 10,000-row
// export cap. GET only, read-only — no requireSameOrigin needed (same as the list route).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { parseOrdersListParams } from "~/lib/order/list-params.server";
import { listOrdersUnified } from "~/lib/order/unified-list.server";
import type { UnifiedOrderRow } from "~/lib/order/unified-list-types";

// A full 10,000-row export can take up to ten sequential RPC round trips — the platform default
// duration is too thin for that.
export const config = { maxDuration: 60 };

// PostgREST clamps every response at 1000 rows regardless of a bigger requested limit — a page
// size above this would silently truncate each page rather than the export as a whole.
const PAGE_SIZE = 1000;
const MAX_ROWS = 10_000;

const HEADER = [
  "ref",
  "date",
  "source",
  "customer",
  "total",
  "currency",
  "payment_status",
  "fulfillment_status",
  "items",
  "tags",
  "cancelled",
  "archived",
];

/** RFC-4180 field escaper with CSV formula-injection protection: prefix risky characters (=, +, -, @, \t) with a single quote; then quote when the value contains a comma, quote, or line break. */
function csvField(value: string): string {
  // CSV formula injection protection: neutralize cells that start with formula indicators
  if (/^[=+\-@\t]/.test(value)) {
    value = `'${value}`;
  }
  if (/[,"\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(",");
}

function orderToRow(row: UnifiedOrderRow): string[] {
  return [
    row.ref,
    row.occurredAt,
    row.source,
    row.buyerEmail ?? "",
    (row.totalCents / 100).toFixed(2),
    row.currency,
    row.paymentStatus,
    row.source === "calderyn" ? row.state : "",
    String(row.itemCount),
    row.tags.join(";"),
    row.cancelledAt ? "yes" : "",
    row.archivedAt ? "yes" : "",
  ];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const params = parseOrdersListParams(url);
  if (params instanceof Response) return params;

  const lines: string[] = [csvRow(HEADER)];
  let offset = 0;
  let truncated = false;

  for (;;) {
    const page = await listOrdersUnified(session.shopId, { ...params, offset, limit: PAGE_SIZE });
    for (const row of page.rows) lines.push(csvRow(orderToRow(row)));
    offset += page.rows.length;

    if (page.rows.length < PAGE_SIZE) break;
    if (offset >= MAX_ROWS) {
      // Only a genuine overflow is a truncation: the result set must hold MORE rows than we exported.
      // A set of EXACTLY MAX_ROWS fills the final page (so the short-page break above never fires) yet
      // drops nothing — page.totalCount (the RPC's full_count) distinguishes the two.
      truncated = page.totalCount > offset;
      break;
    }
  }

  if (truncated) {
    lines.push(csvRow(["export truncated at 10000 rows", "", "", "", "", "", "", "", "", "", "", ""]));
  }

  const csv = lines.join("\r\n") + "\r\n";
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-export-${date}.csv"`,
    },
  });
}
