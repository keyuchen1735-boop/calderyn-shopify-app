// app/routes/storefront.tsx
// Public storefront layout. No authenticate.admin — a genuinely public, SSR route.
import type { LoaderFunctionArgs, LinksFunction, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Outlet } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getRunningExperiment, assignArm } from "~/lib/experiments/store-experiment.server";
import { peekVisitorId } from "~/lib/storefront/visitor-cookie.server";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";

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

/**
 * A running vibe experiment restyles the WHOLE page, not just the home doc's
 * blocks: the vibe token packs redeclare on this .cd-store root, so the swap
 * has to happen here regardless of which child route is being served.
 * Failure-isolated — a lookup/cookie hiccup must never break the shell render.
 */
async function resolveLayoutExperimentVibe(shopId: string, request: Request): Promise<StudioVibe | null> {
  try {
    const experiment = await getRunningExperiment(shopId);
    const vibe = experiment?.variantSettings?.vibe;
    if (!vibe) return null;
    const visitorId = await peekVisitorId(request);
    if (!visitorId) return null;
    return assignArm(visitorId, experiment.id) === "b" ? vibe : null;
  } catch (err) {
    console.error(`[storefront] layout experiment-vibe lookup failed for shop ${shopId}:`, err);
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Public, multi-tenant entry: resolve the tenant from the request, then scope
  // every downstream read by this shopId (no Postgres RLS on this surface).
  const shopId = await resolveStorefrontShop(request);
  const settings = await getStoreSettings(shopId);
  const experimentVibe = await resolveLayoutExperimentVibe(shopId, request);
  return json({ settings, experimentVibe: experimentVibe ?? null });
}

export default function StorefrontLayout() {
  const { settings, experimentVibe } = useLoaderData<typeof loader>();
  return (
    <div
      className="cd-store"
      data-vibe={experimentVibe ?? settings.vibe}
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
