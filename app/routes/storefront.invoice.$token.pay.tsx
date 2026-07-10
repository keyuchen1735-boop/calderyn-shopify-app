// app/routes/storefront.invoice.$token.pay.tsx
// Public pay-link redirect (orders phase 3, Task 2). No dashboard session — the unguessable
// confirmation token IS the auth, same trust model as storefront.checkout.confirmation.$token.tsx.
// The shop is resolved from the REQUEST HOST exactly like every other storefront route
// (resolveStorefrontShop), then the token is looked up scoped to that shop.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { payableInvoiceSession } from "~/lib/order/invoice.server";

export const meta: MetaFunction = () => [{ name: "robots", content: "noindex" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const token = params.token ?? "";
  // The demo shell has no shop row behind it (uuid-keyed invoice/order tables can't hold its
  // sentinel id): an unknown host can never own a payable invoice, so refuse before any DB
  // read rather than let a non-uuid shop_id 500 the `.eq()` filter below.
  if (!token || shopId === DEMO_SHOP_ID) throw new Response("Invoice not found", { status: 404 });

  const resolved = token ? await payableInvoiceSession(shopId, token) : null;
  // Unknown token, foreign-shop token, or an order that isn't channel='invoice' all resolve to
  // null (IDOR-safe, same posture as the confirmation route) -> 404, exposing nothing.
  if (!resolved) throw new Response("Invoice not found", { status: 404 });

  if (resolved.kind === "pay") return redirect(resolved.url);
  if (resolved.kind === "paid") {
    return redirect(`/storefront/checkout/confirmation/${resolved.confirmationToken}`);
  }
  // kind === "void" (cancelled/refunded, nothing left to pay) or "not_ready" (the shop's
  // payments regressed after the invoice was sent). Both render the same minimal standalone
  // page (mirrors dashboard.orders.print.$id.tsx's non-SPA approach: its own tiny inline style,
  // no dashboard/storefront chrome) rather than a bare 404, redirect, or 500.
  return json({ kind: resolved.kind });
}

export default function StorefrontInvoicePay() {
  // The loader always redirects for "pay"/"paid" before this component ever renders, so the
  // only states reachable here are "void" and "not_ready".
  const data = useLoaderData<typeof loader>();
  const notReady = data.kind === "not_ready";
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
        <h1>{notReady ? "Payment is temporarily unavailable." : "This invoice is no longer payable."}</h1>
        <p>
          {notReady
            ? "This store cannot take payment right now. Please try again later or contact the seller."
            : "Please contact the merchant if you have questions about this order."}
        </p>
      </div>
    </>
  );
}
