// Printable packing-slip / invoice page (Task 5). A full-page NON-SPA route:
// it is only ever opened via window.open() from the order detail screen, so it
// renders its own minimal print stylesheet rather than the dashboard chrome
// (no cd-* components, no dashboard.css, no GSAP). loadOrderDetail already
// serves both native and imported orders through one contract, so this route
// never branches on source — it renders whatever fields the order actually has.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError } from "~/lib/dashboard/http.server";
import { loadOrderDetail } from "~/lib/order/detail.server";

type Doc = "packing-slip" | "invoice";

function isDoc(value: string): value is Doc {
  return value === "packing-slip" || value === "invoice";
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);

  const docParam = new URL(request.url).searchParams.get("doc") ?? "packing-slip";
  if (!isDoc(docParam)) throw jsonError(422, "invalid_doc");

  const order = await loadOrderDetail(session.shopId, String(params.id));
  if (!order) throw jsonError(404, "order_not_found");

  return json({ doc: docParam, order, shopLabel: session.shopDomain ?? "Order" });
}

/** Local money formatter: integer cents -> a locale currency string. Kept as a
 *  small standalone helper (rather than importing the storefront one) since
 *  this page has no other dependency on shared app modules. */
function formatCents(cents: number, currency: string): string {
  const code = currency.trim() ? currency.toUpperCase() : "USD";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

export default function OrderPrintPage() {
  const { doc, order, shopLabel } = useLoaderData<typeof loader>();
  const isInvoice = doc === "invoice";
  const title = isInvoice ? "Invoice" : "Packing slip";
  const orderDate = order.createdAt ? new Date(order.createdAt).toLocaleDateString() : "";
  const address = order.shippingAddress;
  const netCents = order.totalCents - order.refundedCents;

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #fff; }
        .print-page {
          max-width: 700px;
          margin: 0 auto;
          padding: 48px 24px 64px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: #111;
          background: #fff;
          line-height: 1.5;
          font-size: 14px;
        }
        .print-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
        .print-header h1 { font-size: 20px; margin: 4px 0 0; font-weight: 600; }
        .print-header .shop { font-size: 14px; font-weight: 600; color: #555; }
        .print-header .meta { font-size: 13px; color: #555; margin-top: 8px; }
        .print-button {
          border: 1px solid #ccc;
          background: #fff;
          border-radius: 6px;
          padding: 8px 16px;
          font-size: 13px;
          font-family: inherit;
          cursor: pointer;
        }
        .print-button:hover { background: #f5f5f5; }
        .address-block { margin-bottom: 32px; }
        .address-block h2 {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #777;
          margin: 0 0 8px;
          font-weight: 600;
        }
        table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
        th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid #e5e5e5; }
        th {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #777;
          font-weight: 600;
        }
        td.num, th.num { text-align: right; }
        .summary { width: 100%; max-width: 280px; margin-left: auto; }
        .summary-row { display: flex; justify-content: space-between; padding: 4px 0; }
        .summary-row.total { font-weight: 700; border-top: 1px solid #ccc; margin-top: 4px; padding-top: 8px; }
        .footer { margin-top: 40px; color: #555; }
        @media print {
          .no-print { display: none; }
          .print-page { padding: 0; max-width: none; }
        }
      `}</style>
      <div className="print-page">
        <div className="print-header">
          <div>
            <div className="shop">{shopLabel}</div>
            <h1>{title}</h1>
            <div className="meta">
              {order.ref}
              {orderDate ? ` · ${orderDate}` : ""}
            </div>
          </div>
          <button type="button" className="no-print print-button" onClick={() => window.print()}>
            Print
          </button>
        </div>

        {address ? (
          <div className="address-block">
            <h2>Ship to</h2>
            {address.name ? <div>{address.name}</div> : null}
            <div>{address.line1}</div>
            {address.line2 ? <div>{address.line2}</div> : null}
            {[address.city, address.region, address.postal].some(Boolean) ? (
              <div>{[address.city, address.region, address.postal].filter(Boolean).join(", ")}</div>
            ) : null}
            {address.country ? <div>{address.country}</div> : null}
          </div>
        ) : null}

        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>SKU</th>
              <th className="num">Qty</th>
              {isInvoice ? <th className="num">Unit price</th> : null}
              {isInvoice ? <th className="num">Line total</th> : null}
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.title}</td>
                <td>{line.sku ?? ""}</td>
                <td className="num">{line.quantity}</td>
                {isInvoice ? <td className="num">{formatCents(line.unitPriceCents, order.currency)}</td> : null}
                {isInvoice ? (
                  <td className="num">{formatCents(line.unitPriceCents * line.quantity, order.currency)}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>

        {isInvoice ? (
          <div className="summary">
            <div className="summary-row">
              <span>Subtotal</span>
              <span>{formatCents(order.subtotalCents, order.currency)}</span>
            </div>
            <div className="summary-row">
              <span>Shipping</span>
              <span>{formatCents(order.shippingCents, order.currency)}</span>
            </div>
            <div className="summary-row">
              <span>Tax</span>
              <span>{formatCents(order.taxCents, order.currency)}</span>
            </div>
            {order.discountCents > 0 ? (
              <div className="summary-row">
                <span>Discount</span>
                <span>-{formatCents(order.discountCents, order.currency)}</span>
              </div>
            ) : null}
            <div className="summary-row total">
              <span>Total</span>
              <span>{formatCents(order.totalCents, order.currency)}</span>
            </div>
            {order.refundedCents > 0 ? (
              <>
                <div className="summary-row">
                  <span>Refunded</span>
                  <span>-{formatCents(order.refundedCents, order.currency)}</span>
                </div>
                <div className="summary-row total">
                  <span>Net</span>
                  <span>{formatCents(netCents, order.currency)}</span>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="footer">Thank you for your order.</div>
        )}
      </div>
    </>
  );
}
