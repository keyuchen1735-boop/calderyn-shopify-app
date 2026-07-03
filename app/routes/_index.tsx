import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { resolveTenantShopId } from "~/lib/storefront/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // A store subdomain's homepage IS its storefront: customers landing on
  // shopname.calderyncompany.com expect products, not platform copy. Platform
  // hosts (app., deploy URLs, localhost) keep the install page below. Fail
  // open to the install page on a transient lookup error — never 500 a
  // homepage over it.
  const tenant = await resolveTenantShopId(request).catch(() => null);
  if (tenant) throw redirect("/storefront");

  return null;
};

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Calderyn</h1>
      <p>Ad-and-inventory autopilot for Shopify merchants.</p>
      <p>
        Install Calderyn from the{" "}
        <a href="https://apps.shopify.com">Shopify App Store</a>, or open it
        from the Apps section of your Shopify admin.
      </p>
    </div>
  );
}
