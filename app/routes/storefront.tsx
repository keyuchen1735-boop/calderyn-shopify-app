// app/routes/storefront.tsx
// Public storefront layout. No authenticate.admin — a genuinely public, SSR route.
import type { LoaderFunctionArgs, LinksFunction, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Outlet } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
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

/** Collections for the header category nav — the store chrome that makes a page read as a real
 *  storefront (For Him / For Her …) rather than a bare hero. Failure-isolated (a catalog hiccup
 *  must never break the shell) and capped so a large catalog can't overflow the bar. */
async function loadNavCollections(shopId: string): Promise<{ handle: string; title: string }[]> {
  try {
    const cols = await getCatalog().listCollections(shopId);
    return cols.slice(0, 6).map((c) => ({ handle: c.handle, title: c.title }));
  } catch (err) {
    console.error(`[storefront] nav collections lookup failed for shop ${shopId}:`, err);
    return [];
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Public, multi-tenant entry: resolve the tenant from the request, then scope
  // every downstream read by this shopId (no Postgres RLS on this surface).
  const shopId = await resolveStorefrontShop(request);
  const settings = await getStoreSettings(shopId);
  const experimentVibe = await resolveLayoutExperimentVibe(shopId, request);
  const collections = await loadNavCollections(shopId);
  return json({ settings, experimentVibe: experimentVibe ?? null, collections });
}

export default function StorefrontLayout() {
  const { settings, experimentVibe, collections } = useLoaderData<typeof loader>();
  const navCollections = collections ?? [];
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
      {navCollections.length > 0 ? (
        <nav className="cd-store__nav">
          {navCollections.map((c) => (
            <a key={c.handle} href={`/storefront/collections/${c.handle}`}>
              {c.title}
            </a>
          ))}
        </nav>
      ) : null}
      <main>
        <Outlet />
      </main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
