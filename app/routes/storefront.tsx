// app/routes/storefront.tsx
// Public storefront layout. No authenticate.admin — a genuinely public, SSR route.
import type { LoaderFunctionArgs, LinksFunction, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Outlet } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];

export const meta: MetaFunction = () => {
  const title = "Calderyn Demo Store";
  const description = "Browse the Calderyn Demo Store.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Public, multi-tenant entry: resolve the tenant from the request, then scope
  // every downstream read by this shopId (no Postgres RLS on this surface).
  const shopId = await resolveStorefrontShop(request);
  const settings = getStoreSettings(shopId);
  return json({ settings });
}

export default function StorefrontLayout() {
  const { settings } = useLoaderData<typeof loader>();
  return (
    <div
      className="cd-store"
      style={{ background: settings.palette.background, color: settings.palette.text }}
    >
      <header className="cd-store__header">
        <a className="cd-store__logo" href="/storefront">
          <img src={settings.logoUrl} alt={settings.storeName} />
          <span>{settings.storeName}</span>
        </a>
        <a className="cd-store__cart" href="/storefront/cart">
          Cart
        </a>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
