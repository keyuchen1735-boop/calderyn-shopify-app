// app/routes/storefront.recover.$token.tsx
// Public abandoned-checkout resume link (orders phase 3, Task 4). No dashboard session — the
// unguessable confirmation token IS the auth, same trust model as
// storefront.checkout.confirmation.$token.tsx and storefront.invoice.$token.pay.tsx. The shop is
// resolved from the REQUEST HOST exactly like every other storefront route (resolveStorefrontShop),
// then the token is looked up scoped to that shop.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { getSupabase } from "~/lib/supabase.server";
import { buildCart, addCartLine, VariantUnavailableError } from "~/lib/order/cart.server";
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
import { isRecoverableOrderState } from "~/lib/order/recovery.server";

export const meta: MetaFunction = () => [{ name: "robots", content: "noindex" }];

interface RecoverOrderLine {
  variantId: string;
  quantity: number;
}

async function loadRecoverableOrder(
  shopId: string,
  token: string,
): Promise<{ orderId: string; lines: RecoverOrderLine[] } | null> {
  const sb = getSupabase();
  const orderRes = await sb
    .from("orders")
    .select("id, channel, state")
    .eq("shop_id", shopId)
    .eq("confirmation_token", token)
    .maybeSingle();
  if (orderRes.error) throw orderRes.error;
  const row = orderRes.data as Record<string, unknown> | null;
  // Unknown token, foreign-shop token, or an order that isn't channel='storefront' all resolve to
  // null (IDOR-safe, same posture as the invoice pay route) -> 404, exposing nothing.
  if (!row || row.channel !== "storefront") return null;

  const orderId = String(row.id);
  const state = String(row.state);
  if (!(await isRecoverableOrderState(shopId, orderId, state))) return null;

  const lineRes = await sb
    .from("order_line")
    .select("variant_id, quantity")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (lineRes.error) throw lineRes.error;
  const lines = ((lineRes.data ?? []) as Record<string, unknown>[]).map((l) => ({
    variantId: String(l.variant_id),
    quantity: Number(l.quantity ?? 0),
  }));

  return { orderId, lines };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const token = params.token ?? "";
  // The demo shell has no shop row behind it (uuid-keyed cart/orders tables can't hold its
  // sentinel id): an unknown host can never own a recoverable order, so refuse before any DB
  // read rather than let a non-uuid shop_id 500 the `.eq()` filter below.
  if (!token || shopId === DEMO_SHOP_ID) throw new Response("Not found", { status: 404 });

  const found = await loadRecoverableOrder(shopId, token);
  if (!found) throw new Response("Not found", { status: 404 });

  // Build a FRESH cart rather than reviving the original — the source cart may already be
  // consumed (createCheckout marks it checkout_pending), and addCartLine re-prices every line
  // against the LIVE catalog, so the buyer sees current prices/availability, not the stale
  // snapshot from when they first checked out.
  const cart = await buildCart(shopId);
  let addedCount = 0;
  for (const line of found.lines) {
    try {
      await addCartLine(shopId, cart.id, line.variantId, line.quantity);
      addedCount++;
    } catch (err) {
      // A variant that sold out / was archived / was deleted since the original checkout: skip
      // it (rule 12: fail visibly for anything else — a genuine DB fault still propagates) rather
      // than let one bad line dead-end the whole recovery.
      if (err instanceof VariantUnavailableError) continue;
      throw err;
    }
  }

  if (addedCount === 0) {
    // Every line is gone — nothing to resume into. Render the standalone notice instead of
    // committing an empty cart cookie or redirecting into a blank basket.
    return json({ allGone: true as const });
  }

  const upd = await getSupabase()
    .from("cart")
    .update({ origin: `recovery:${found.orderId}` })
    .eq("shop_id", shopId)
    .eq("id", cart.id);
  if (upd.error) throw upd.error;

  const headers = new Headers();
  headers.append("Set-Cookie", await commitCartId(cart.id));
  return redirect("/storefront/cart", { headers });
}

export default function StorefrontRecover() {
  // The loader always redirects when at least one line survived, so the only state reachable
  // here is "every line is gone".
  useLoaderData<typeof loader>();
  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #fff; }
        .recover-gone {
          max-width: 480px;
          margin: 96px auto;
          padding: 0 24px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: #111;
          text-align: center;
          line-height: 1.5;
        }
        .recover-gone h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
        .recover-gone p { font-size: 14px; color: #555; margin: 0 0 16px; }
        .recover-gone a { color: #111; }
      `}</style>
      <div className="recover-gone">
        <h1>These items are no longer available.</h1>
        <p>Sorry, everything in this order has since sold out or been removed.</p>
        <a href="/storefront">Continue shopping</a>
      </div>
    </>
  );
}
