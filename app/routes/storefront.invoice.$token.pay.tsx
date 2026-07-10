// app/routes/storefront.invoice.$token.pay.tsx
// Public pay-link redirect (orders phase 3, Task 2). No dashboard session — the unguessable
// confirmation token IS the auth, same trust model as storefront.checkout.confirmation.$token.tsx.
// The shop is resolved from the REQUEST HOST exactly like every other storefront route
// (resolveStorefrontShop), then the token is looked up scoped to that shop.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { payableInvoiceSession } from "~/lib/order/invoice.server";

export const meta: MetaFunction = () => [{ name: "robots", content: "noindex" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const token = params.token ?? "";
  const resolved = token ? await payableInvoiceSession(shopId, token) : null;
  // Unknown token, foreign-shop token, or an order that isn't channel='invoice' all resolve to
  // null (IDOR-safe, same posture as the confirmation route) -> 404, exposing nothing.
  if (!resolved) throw new Response("Invoice not found", { status: 404 });

  if (resolved.kind === "pay") return redirect(resolved.url);
  if (resolved.kind === "paid") {
    return redirect(`/storefront/checkout/confirmation/${resolved.confirmationToken}`);
  }
  // kind === "void": cancelled/refunded — nothing left to pay. Render a minimal standalone
  // page (mirrors dashboard.orders.print.$id.tsx's non-SPA approach: its own tiny inline
  // style, no dashboard/storefront chrome) rather than a bare 404 or redirect.
  return json({ kind: "void" as const });
}

export default function StorefrontInvoicePay() {
  // The loader always redirects for "pay"/"paid" before this component ever renders, so the
  // only state reachable here is "void".
  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #fff; }
        .invoice-void {
          max-width: 480px;
          margin: 96px auto;
          padding: 0 24px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: #111;
          text-align: center;
          line-height: 1.5;
        }
        .invoice-void h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
        .invoice-void p { font-size: 14px; color: #555; margin: 0; }
      `}</style>
      <div className="invoice-void">
        <h1>This invoice is no longer payable.</h1>
        <p>Please contact the merchant if you have questions about this order.</p>
      </div>
    </>
  );
}
