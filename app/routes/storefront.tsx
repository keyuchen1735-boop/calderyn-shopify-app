// app/routes/storefront.tsx
// Public storefront layout. No authenticate.admin — a genuinely public, SSR route.
import type { LoaderFunctionArgs, LinksFunction, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Outlet, useMatches } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { detectAiBot, logAiCrawl } from "~/lib/seo/crawlers.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data?.settings.storeName || "Calderyn Store";
  const description = `Browse ${title}.`;
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
  // AIO signal: record when a known AI assistant crawler reads any storefront page.
  // logAiCrawl is fire-and-forget and never throws; waitUntil keeps the serverless
  // function alive until the RPC resolves so the write survives function freeze on
  // Vercel, and no-ops locally (mirrors tenant.server / import/run.server).
  const aiBot = detectAiBot(request.headers.get("user-agent"));
  if (aiBot) {
    const crawlLog = logAiCrawl(shopId, aiBot);
    try {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(crawlLog);
    } catch {
      void crawlLog;
    }
  }
  const settings = await getStoreSettings(shopId);
  return json({ settings, experimentVibe: null, collections: [] });
}

export default function StorefrontLayout() {
  const { settings, experimentVibe } = useLoaderData<typeof loader>();
  const matches = useMatches();
  if (matches.some((match) => {
    const data = match.data;
    return Boolean(data && typeof data === "object" && "runtime" in data && data.runtime === 1);
  })) return <Outlet />;
  return (
    <div
      className="cd-store"
      data-vibe={experimentVibe ?? settings.vibe}
      data-type={settings.typeStyle ?? "classic"}
      data-density={settings.density ?? "standard"}
      style={{ background: settings.palette.background, color: settings.palette.text, ["--cd-primary" as string]: settings.palette.primary }}
    >
      <header className="cd-store__header">
        <a className="cd-store__logo" href="/storefront">
          {settings.logoUrl ? <img src={settings.logoUrl} alt={settings.storeName} /> : null}
          <span>{settings.storeName}</span>
        </a>
        <nav className="cd-store__account-nav">
          <a className="cd-store__account" href="/storefront/account">
            Account
          </a>
          <a className="cd-store__cart" href="/storefront/cart">
            Cart
          </a>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
