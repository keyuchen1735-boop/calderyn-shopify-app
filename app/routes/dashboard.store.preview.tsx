// app/routes/dashboard.store.preview.tsx
// The Store studio frames this route to show the merchant's ACTUAL generated
// storefront draft as they prompt — the same renderBlocks the live storefront
// uses, styled with the real storefront.css so it looks like what will publish.
// Session-gated (only the owner sees their own draft), same-origin frameable
// (see entry.server SELF_FRAMEABLE_PATH), and never blank (falls back to the
// deterministic starter doc when nothing has been generated yet).
import type { LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { loadDraftDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { PREVIEW_LINKS } from "~/lib/storebuilder/links";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";
import { fallbackDoc } from "~/lib/storegen/fallback";
import type { PageKey, RenderContext } from "~/lib/storebuilder/types";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];

const PAGES: PageKey[] = ["home", "collection", "pdp"];
function pageParam(url: string): PageKey {
  const p = new URL(url).searchParams.get("page");
  return PAGES.includes(p as PageKey) ? (p as PageKey) : "home";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const shopId = session.shopId;
  const page = pageParam(request.url);
  const catalog = getCatalog();
  const [settings, draft, products, collections] = await Promise.all([
    getStoreSettings(shopId),
    loadDraftDoc(shopId, page),
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
  ]);
  const brand = { storeName: settings.storeName, tagline: settings.voiceTagline ?? "" };
  // Never blank (rule 12): a merchant who hasn't generated — or a page with no
  // draft — still sees the deterministic starter layout the storefront publishes.
  const doc = draft ?? (page === "home" ? defaultHomeDocument() : fallbackDoc(page, brand));
  // Template pages (collection/pdp) bind their dynamic blocks to a record. In the
  // preview a click-through arrives as ?handle=… (a product for pdp, a collection for
  // collection); resolve that specific record, falling back to the first item so the
  // page never blanks — exactly as the live storefront binds a real product/collection.
  const handle = new URL(request.url).searchParams.get("handle");
  let record: RenderContext["record"];
  if (page === "home") {
    record = undefined;
  } else if (page === "pdp") {
    const product = (handle ? await catalog.getProduct(shopId, handle) : null) ?? products[0];
    record = { product, collection: collections[0] };
  } else {
    const collection = (handle ? collections.find((c) => c.handle === handle) : undefined) ?? collections[0];
    record = { collection, product: products[0] };
  }
  const data = await resolveRenderData(doc, shopId, catalog, record);
  // Shape a display-only DTO — never ship the internal shop_id to the browser
  // (the preview only needs the visible branding fields).
  const settingsDto = {
    storeName: settings.storeName,
    logoUrl: settings.logoUrl,
    palette: settings.palette,
    vibe: settings.vibe,
  };
  return json({ doc, data, record, settings: settingsDto });
}

export default function StoreDraftPreview() {
  const { doc, data, record, settings } = useLoaderData<typeof loader>();
  return (
    <div
      className="cd-store"
      data-vibe={settings.vibe}
      style={{ background: settings.palette.background, color: settings.palette.text, ["--cd-primary" as string]: settings.palette.primary }}
    >
      <header className="cd-store__header">
        {/* The logo returns to the home preview; account/cart have no preview page,
            so they stay inert spans. Catalog links inside <main> navigate the iframe
            between preview pages (see PREVIEW_LINKS). */}
        <a className="cd-store__logo" href="?page=home">
          {settings.logoUrl ? <img src={settings.logoUrl} alt={settings.storeName} /> : null}
          <span>{settings.storeName}</span>
        </a>
        <nav className="cd-store__account-nav">
          <span className="cd-store__account">Account</span>
          <span className="cd-store__cart">Cart</span>
        </nav>
      </header>
      {/* Interactive preview: catalog links navigate the iframe between preview pages
          via PREVIEW_LINKS, so a merchant can click through their own store. The iframe
          sandbox (allow-same-origin only — no allow-forms / allow-top-navigation) keeps
          every navigation inside the frame and blocks the buy-path form POST. */}
      <main>{renderBlocks(doc, { data, record, links: PREVIEW_LINKS })}</main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
