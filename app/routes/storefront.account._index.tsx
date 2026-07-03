// app/routes/storefront.account._index.tsx
// Buyer account home (platform pivot #1b). Requires a live buyer session. Shows order history,
// saved addresses (add/remove), a link to manage saved cards, sign-out, and GDPR account
// deletion. All reads/writes are scoped to (shop, buyer) by the session — a buyer can only ever
// see and mutate their own data.
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { requireBuyerSession, revokeBuyerSession, clearBuyerSessionCookieHeader } from "~/lib/buyer/session.server";
import { addBuyerAddress } from "~/lib/buyer/identity.server";
import { listBuyerAddresses, listBuyerOrders, deleteBuyerAddress, deleteBuyerAccount } from "~/lib/buyer/account.server";
import { formatOrderRef } from "~/lib/order/checkout.server";
import { formatMoney as money } from "~/lib/storefront/money";
import { storeNameFromMatches } from "~/lib/storefront/meta";

export const meta: MetaFunction = ({ matches }) => [
  { title: `Your account — ${storeNameFromMatches(matches)}` },
  { name: "robots", content: "noindex" },
];

const ORDER_STATUS_LABEL: Record<string, string> = {
  checkout_pending: "Payment processing",
  paid: "Confirmed",
  fulfilled: "Shipped",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");
  const { buyerId } = await requireBuyerSession(request, shopId);

  const [addresses, orders] = await Promise.all([
    listBuyerAddresses(shopId, buyerId),
    listBuyerOrders(shopId, buyerId),
  ]);

  return json({
    addresses,
    orders: orders.map((o) => ({
      ref: formatOrderRef(o.orderId),
      status: ORDER_STATUS_LABEL[o.state] ?? o.state,
      totalCents: o.totalCents,
      currency: o.currency,
      createdAt: o.createdAt,
      confirmationToken: o.confirmationToken,
    })),
  });
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");
  const session = await requireBuyerSession(request, shopId);
  const { buyerId } = session;

  const form = await request.formData();
  const intent = str(form, "intent");

  if (intent === "logout") {
    await revokeBuyerSession(session.sessionId);
    return redirect("/storefront", { headers: { "Set-Cookie": clearBuyerSessionCookieHeader() } });
  }

  if (intent === "delete-account") {
    // GDPR deletion: removes buyer PII + detaches Stripe cards; warehouse facts are untouched.
    await deleteBuyerAccount(shopId, buyerId);
    return redirect("/storefront", { headers: { "Set-Cookie": clearBuyerSessionCookieHeader() } });
  }

  if (intent === "delete-address") {
    await deleteBuyerAddress(shopId, buyerId, str(form, "addressId"));
    return redirect("/storefront/account");
  }

  if (intent === "add-address") {
    const kind = str(form, "kind") === "billing" ? "billing" : "shipping";
    // addBuyerAddress validates kind + line1 + country at the boundary and throws on a bad shape;
    // surface that as a 400 rather than a 500.
    try {
      await addBuyerAddress(shopId, buyerId, {
        kind,
        name: str(form, "name") || null,
        line1: str(form, "line1"),
        line2: str(form, "line2") || null,
        city: str(form, "city") || null,
        region: str(form, "region") || null,
        postal: str(form, "postal") || null,
        country: str(form, "country"),
        phone: str(form, "phone") || null,
        isDefault: form.get("isDefault") === "on",
      });
    } catch {
      return json({ error: "Please provide at least a street address and country." }, { status: 400 });
    }
    return redirect("/storefront/account");
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

export default function BuyerAccount() {
  const { addresses, orders } = useLoaderData<typeof loader>();
  return (
    <section className="cd-account">
      <div className="cd-account__head">
        <h1>Your account</h1>
        <Form method="post">
          <button type="submit" name="intent" value="logout" className="cd-account__link-btn">
            Sign out
          </button>
        </Form>
      </div>

      <div className="cd-account__section">
        <h2>Order history</h2>
        {orders.length === 0 ? (
          <p className="cd-account__muted">You haven&apos;t placed any orders yet.</p>
        ) : (
          <ul className="cd-account__orders">
            {orders.map((o) => (
              <li key={o.ref} className="cd-account__order">
                <span className="cd-account__order-ref">
                  {o.confirmationToken ? (
                    <a href={`/storefront/checkout/confirmation/${o.confirmationToken}`}>{o.ref}</a>
                  ) : (
                    o.ref
                  )}
                </span>
                <span className="cd-account__order-date">{new Date(o.createdAt).toLocaleDateString()}</span>
                <span className="cd-account__order-status">{o.status}</span>
                <span className="cd-account__order-total">{money(o.totalCents, o.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="cd-account__section">
        <div className="cd-account__section-head">
          <h2>Saved addresses</h2>
        </div>
        {addresses.length === 0 ? (
          <p className="cd-account__muted">No saved addresses yet.</p>
        ) : (
          <ul className="cd-account__addresses">
            {addresses.map((a) => (
              <li key={a.id} className="cd-account__address">
                <div>
                  <span className="cd-account__address-kind">{a.kind}</span>
                  {a.isDefault ? <span className="cd-account__badge">Default</span> : null}
                  <div className="cd-account__address-lines">
                    {a.name ? <div>{a.name}</div> : null}
                    <div>{a.line1}{a.line2 ? `, ${a.line2}` : ""}</div>
                    <div>
                      {[a.city, a.region, a.postal].filter(Boolean).join(", ")} {a.country}
                    </div>
                  </div>
                </div>
                <Form method="post">
                  <input type="hidden" name="addressId" value={a.id} />
                  <button type="submit" name="intent" value="delete-address" className="cd-account__link-btn">
                    Remove
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        )}

        <details className="cd-account__add">
          <summary>Add an address</summary>
          <Form method="post" className="cd-account__form">
            <input type="hidden" name="intent" value="add-address" />
            <label className="cd-account__field">
              <span>Type</span>
              <select name="kind" defaultValue="shipping">
                <option value="shipping">Shipping</option>
                <option value="billing">Billing</option>
              </select>
            </label>
            <label className="cd-account__field">
              <span>Full name</span>
              <input type="text" name="name" autoComplete="name" />
            </label>
            <label className="cd-account__field">
              <span>Address</span>
              <input type="text" name="line1" autoComplete="address-line1" required />
            </label>
            <label className="cd-account__field">
              <span>Apartment, suite, etc. (optional)</span>
              <input type="text" name="line2" autoComplete="address-line2" />
            </label>
            <label className="cd-account__field">
              <span>City</span>
              <input type="text" name="city" autoComplete="address-level2" />
            </label>
            <label className="cd-account__field">
              <span>State / region</span>
              <input type="text" name="region" autoComplete="address-level1" />
            </label>
            <label className="cd-account__field">
              <span>Postal code</span>
              <input type="text" name="postal" autoComplete="postal-code" />
            </label>
            <label className="cd-account__field">
              <span>Country</span>
              <input type="text" name="country" autoComplete="country-name" required />
            </label>
            <label className="cd-account__consent">
              <input type="checkbox" name="isDefault" /> <span>Set as my default</span>
            </label>
            <button type="submit" className="cd-account__submit">
              Save address
            </button>
          </Form>
        </details>
      </div>

      <div className="cd-account__section">
        <h2>Payment methods</h2>
        <a className="cd-account__link" href="/storefront/account/cards">
          Manage saved cards
        </a>
      </div>

      <div className="cd-account__section cd-account__danger">
        <h2>Delete account</h2>
        <p className="cd-account__muted">
          Permanently deletes your account, saved addresses, and saved cards. This can&apos;t be undone.
        </p>
        <Form
          method="post"
          onSubmit={(e) => {
            if (!confirm("Permanently delete your account? This can't be undone.")) e.preventDefault();
          }}
        >
          <button type="submit" name="intent" value="delete-account" className="cd-account__delete">
            Delete my account
          </button>
        </Form>
      </div>
    </section>
  );
}
