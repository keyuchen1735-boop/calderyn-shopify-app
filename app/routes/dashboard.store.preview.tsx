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
  // Template pages (collection/pdp) bind their dynamic blocks to a sample record,
  // exactly as the live storefront does for a real collection/product.
  const record: RenderContext["record"] =
    page === "home" ? undefined : { product: products[0], collection: collections[0] };
  const data = await resolveRenderData(doc, shopId, catalog, record);
  return json({ doc, data, record, settings });
}

export default function StoreDraftPreview() {
  const { doc, data, record, settings } = useLoaderData<typeof loader>();
  return (
    <div
      className="cd-store"
      style={{ background: settings.palette.background, color: settings.palette.text }}
    >
      <header className="cd-store__header">
        {/* Inert chrome: this is a display-only preview, so the logo/account/cart
            are spans, not links — the iframe must never navigate away from the draft. */}
        <span className="cd-store__logo">
          {settings.logoUrl ? <img src={settings.logoUrl} alt={settings.storeName} /> : null}
          <span>{settings.storeName}</span>
        </span>
        <nav className="cd-store__account-nav">
          <span className="cd-store__account">Account</span>
          <span className="cd-store__cart">Cart</span>
        </nav>
      </header>
      {/* Display-only preview: `inert` removes the whole rendered store from the
          tab order, pointer hit-testing and the a11y tree, so neither a mouse nor
          a keyboard/screen-reader user can activate a rendered link and navigate
          the iframe off the draft. Rendered server-side (the frame runs no
          scripts), so it must be in the SSR HTML, not applied via a ref. */}
      <main {...({ inert: "" } as Record<string, string>)} style={{ pointerEvents: "none" }}>
        {renderBlocks(doc, { data, record })}
      </main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
