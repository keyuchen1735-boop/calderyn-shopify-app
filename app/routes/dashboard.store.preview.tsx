// app/routes/dashboard.store.preview.tsx
// The Store studio frames this route to show the merchant's ACTUAL generated
// storefront draft as they prompt — the same renderBlocks the live storefront
// uses, styled with the real storefront.css so it looks like what will publish.
// Session-gated (only the owner sees their own draft), same-origin frameable
// (see entry.server SELF_FRAMEABLE_PATH), and never blank (falls back to the
// deterministic starter doc when nothing has been generated yet).
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useEffect } from "react";
import { randomBytes } from "node:crypto";
import storefrontCss from "~/styles/storefront.css?url";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog, getPreviewCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import { loadDraftDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { PdpBlockColumns } from "~/lib/storebuilder/pdp-layout";
import { PREVIEW_LINKS } from "~/lib/storebuilder/links";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";
import { fallbackDoc } from "~/lib/storegen/fallback";
import type { BlockDocument, PageKey, RenderContext } from "~/lib/storebuilder/types";
import { isStorefrontBundleReadEnabled } from "~/lib/storefront-runtime/csp.server";
import { resolveRuntime1VersionRoute } from "~/lib/storefront-runtime/release-resolution.server";
import { isRuntime1RenderData, renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import {
  commitPreviewCommerceSession,
  createPreviewCommerceAdapter,
  readPreviewBundleVersion,
  readPreviewCommerceSession,
} from "~/lib/storefront-runtime/preview-commerce.server";
import type { PublicRouteContext } from "~/lib/storefront-runtime/public-data.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { getStorefrontRecipe } from "~/lib/storefront-recipes";
import { isStoreTemplateId, STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import type { StorefrontVersionRecord } from "~/lib/storefront-runtime/release-resolution.server";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

const PAGES: PageKey[] = ["home", "collection", "pdp"];
function pageParam(url: string): PageKey {
  const p = new URL(url).searchParams.get("page");
  return PAGES.includes(p as PageKey) ? (p as PageKey) : "home";
}

// AI-generated home pages arrive as rawHtml blocks whose anchors hardcode /storefront/… paths.
// Inside the preview iframe those resolve against the DASHBOARD origin, whose /storefront
// host-resolves to the demo shell — a click would land the merchant on a store that isn't
// theirs. Rewrite them (display-only, in the loader; the stored doc is never touched) to the
// merchant's real tenant storefront, opened outside the iframe.
const STOREFRONT_HREF_DQ = /href="(\/storefront(?:[/?#][^"]*)?)"/g;
const STOREFRONT_HREF_SQ = /href='(\/storefront(?:[/?#][^']*)?)'/g;

/** Rewrite /storefront… hrefs in a raw HTML string. With a tenant origin they become absolute
 *  links to the live store, opened in a new tab; without one (shop has no org_slug yet, or dev,
 *  where the tenant host doesn't exist) they turn inert (href="#", no target) so a click can
 *  never eject the merchant to the wrong store. Non-storefront hrefs and anchors without an
 *  href pass through untouched. Pure — trivially testable. */
export function rewriteStorefrontHrefs(html: string, tenantOrigin: string | null): string {
  const sub = (path: string, q: string): string =>
    tenantOrigin ? `href=${q}${tenantOrigin}${path}${q} target=${q}_blank${q} rel=${q}noopener${q}` : `href=${q}#${q}`;
  return html
    .replace(STOREFRONT_HREF_DQ, (_m, path: string) => sub(path, '"'))
    .replace(STOREFRONT_HREF_SQ, (_m, path: string) => sub(path, "'"));
}

/** Apply rewriteStorefrontHrefs to every rawHtml block. Cheap no-op for docs without one. */
export function rewriteDocStorefrontHrefs(doc: BlockDocument, tenantOrigin: string | null): BlockDocument {
  if (!doc.blocks.some((b) => b.type === "rawHtml")) return doc;
  return {
    ...doc,
    blocks: doc.blocks.map((b) =>
      b.type === "rawHtml" && typeof b.props.html === "string"
        ? { ...b, props: { ...b.props, html: rewriteStorefrontHrefs(b.props.html, tenantOrigin) } }
        : b,
    ),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shop's live storefront origin (https://<org_slug>.calderyncompany.com), or null when the
 *  shop has no org_slug / in dev — the callers' cue to render inert links instead. Fail-soft:
 *  a URL nicety must never 500 the preview. */
async function tenantStorefrontOrigin(shopId: string): Promise<string | null> {
  if (process.env.NODE_ENV === "development" || !UUID_RE.test(shopId)) return null;
  try {
    const { data, error } = await getSupabase().from("shops").select("org_slug").eq("id", shopId).maybeSingle();
    if (error) {
      console.error("[store-preview] org_slug lookup failed", { shopId, error: error.message });
      return null;
    }
    const slug = typeof data?.org_slug === "string" && data.org_slug ? data.org_slug : null;
    return slug ? `https://${tenantDomain(slug)}` : null;
  } catch (err) {
    console.error("[store-preview] org_slug lookup errored", err);
    return null;
  }
}

async function previewRouteContext(request: Request, shopId: string): Promise<PublicRouteContext> {
  const url = new URL(request.url);
  const route = url.searchParams.get("route") ?? "home";
  const catalog = getCatalog();
  if (route === "product") {
    const requested = url.searchParams.get("handle");
    const handle = requested ?? (await catalog.listProducts(shopId, { limit: 1 }))[0]?.handle ?? "";
    return { kind: "product", handle };
  }
  if (route === "collection") {
    const requested = url.searchParams.get("handle");
    const handle = requested ?? (await catalog.listCollections(shopId))[0]?.handle ?? "";
    return { kind: "collection", handle };
  }
  if (route === "search") return { kind: "search", query: url.searchParams.get("q")?.slice(0, 200) ?? "" };
  if (route === "cart" || route === "checkout") return { kind: route };
  return { kind: "home" };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const shopId = session.shopId;
  if (isStorefrontBundleReadEnabled()) {
    const templateId = new URL(request.url).searchParams.get("template");
    const registered = isStoreTemplateId(templateId) && STORE_TEMPLATE_REGISTRY.templates.some((template) => template.id === templateId)
      ? templateId
      : null;
    if (registered) {
      const recipe = getStorefrontRecipe(registered);
      const version: StorefrontVersionRecord = {
        id: `preview:${registered}`,
        shopId,
        sourceKind: "recipe",
        status: "validated",
        schemaVersion: recipe.bundle.schemaVersion,
        runtimeVersion: recipe.bundle.runtimeVersion,
        validationProfileVersion: recipe.bundle.validationProfileVersion,
        artifactHash: `sha256:${recipe.hash}`,
        artifact: { sourceKind: "recipe", bundle: recipe.bundle },
        createdAt: new Date(0).toISOString(),
      };
      const route = await previewRouteContext(request, shopId);
      const commerce = await readPreviewCommerceSession(request, shopId);
      const runtime1 = await resolveRuntime1VersionRoute({
        shopId,
        route,
        version,
        dataDependencies: { catalog: getPreviewCatalog(), cartLoader: async () => commerce.cart },
      });
      if (runtime1) {
        const nonce = randomBytes(18).toString("base64url");
        const headers = storefrontCacheHeaders({ routeId: "preview", personalized: true });
        return json({ ...runtime1, nonce }, { headers });
      }
    }
    const version = await readPreviewBundleVersion(shopId);
    if (version) {
      const route = await previewRouteContext(request, shopId);
      const commerce = await readPreviewCommerceSession(request, shopId);
      const runtime1 = await resolveRuntime1VersionRoute({
        shopId,
        route,
        version,
        dataDependencies: { catalog: getPreviewCatalog(), cartLoader: async () => commerce.cart },
      });
      if (runtime1) {
        const nonce = randomBytes(18).toString("base64url");
        const headers = storefrontCacheHeaders({ routeId: "preview", personalized: true });
        return json({ ...runtime1, nonce }, { headers });
      }
    }
  }
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
  const stored = draft ?? (page === "home" ? defaultHomeDocument() : fallbackDoc(page, brand));
  // Display-only href rewrite (see rewriteStorefrontHrefs) — the org_slug read only happens
  // when the doc actually carries rawHtml, so block-vocabulary previews skip the round trip.
  const doc = stored.blocks.some((b) => b.type === "rawHtml")
    ? rewriteDocStorefrontHrefs(stored, await tenantStorefrontOrigin(shopId))
    : stored;
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
    typeStyle: settings.typeStyle,
    density: settings.density,
  };
  return json({ doc, data, record, settings: settingsDto });
}

export async function action({ request }: ActionFunctionArgs) {
  const session = await requireDashboardSession(request);
  const shopId = session.shopId;
  const selectedTemplateId = new URL(request.url).searchParams.get("template");
  const hasEphemeralRecipe = isStoreTemplateId(selectedTemplateId) &&
    STORE_TEMPLATE_REGISTRY.templates.some((template) => template.id === selectedTemplateId);
  if (!isStorefrontBundleReadEnabled() || (!hasEphemeralRecipe && !(await readPreviewBundleVersion(shopId)))) {
    throw new Response(null, { status: 404 });
  }
  const current = await readPreviewCommerceSession(request, shopId);
  const adapter = createPreviewCommerceAdapter(current);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "checkout") {
    return json(adapter.checkout(), { headers: storefrontCacheHeaders({ routeId: "preview", personalized: true }) });
  }
  if (intent === "add") {
    const variantId = form.get("variantId");
    const quantity = Number(form.get("quantity") ?? 1);
    if (typeof variantId !== "string" || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Response("Invalid preview cart line", { status: 400 });
    }
    const catalog = getCatalog();
    const resolved = catalog.getVariantById
      ? await catalog.getVariantById(shopId, variantId)
      : (await catalog.listProducts(shopId)).flatMap((product) => product.variants.map((variant) => ({ product, variant })))
        .find((entry) => entry.variant.id === variantId) ?? null;
    if (!resolved || !resolved.variant.available) throw new Response("Variant unavailable", { status: 422 });
    adapter.add({
      lineId: `preview:${variantId}`,
      variantId,
      title: resolved.variant.title && resolved.variant.title !== resolved.product.title
        ? `${resolved.product.title} - ${resolved.variant.title}`
        : resolved.product.title,
      quantity,
      unitPrice: { cents: resolved.variant.priceCents, currency: resolved.variant.currency.toUpperCase() },
    });
  } else if (intent === "quantity") {
    const lineId = form.get("lineId");
    const quantity = Number(form.get("quantity"));
    if (typeof lineId !== "string") throw new Response("lineId is required", { status: 400 });
    adapter.setQuantity(lineId, quantity);
  } else if (intent === "remove") {
    const lineId = form.get("lineId");
    if (typeof lineId !== "string") throw new Response("lineId is required", { status: 400 });
    adapter.remove(lineId);
  } else if (intent === "clear") adapter.clear();
  else throw new Response("Unknown preview action", { status: 400 });

  const headers = storefrontCacheHeaders({ routeId: "preview", personalized: true });
  headers.append("Set-Cookie", await commitPreviewCommerceSession(adapter.snapshot()));
  return json({ cart: adapter.cart() }, { headers });
}

export function previewCompilerId(target: Element): string | null {
  const selected = target.closest<HTMLElement>("[data-cd-compiler-id]");
  const compilerId = selected?.dataset.cdCompilerId;
  return typeof compilerId === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(compilerId) ? compilerId : null;
}

export default function StoreDraftPreview() {
  const loaded = useLoaderData<typeof loader>();
  useEffect(() => {
    if (!isRuntime1RenderData(loaded)) return;
    const selectRegion = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cd-compiler-id]") : null;
      const route = target?.closest<HTMLElement>("[data-cd-bundle-route]")?.dataset.cdBundleRoute;
      const compilerId = target ? previewCompilerId(target) : null;
      if (!target || !route || !compilerId) return;
      window.parent.postMessage({
        type: "storefront-preview-region",
        routeId: route,
        regionId: compilerId,
      }, window.location.origin);
    };
    document.addEventListener("click", selectRegion, { capture: true });
    return () => document.removeEventListener("click", selectRegion, { capture: true });
  }, [loaded]);
  if (isRuntime1RenderData(loaded)) {
    return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: loaded.routeId, data: loaded.data, nonce: loaded.nonce, mode: "preview" })}<StorefrontHydrator bundle={loaded.bundle} routeId={loaded.routeId} data={loaded.data} mode="preview" /></>;
  }
  const { doc, data, record, settings } = loaded;
  return (
    <div
      className="cd-store"
      data-vibe={settings.vibe}
      data-type={settings.typeStyle ?? "classic"}
      data-density={settings.density ?? "standard"}
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
      <main>
        {doc.pageKey === "pdp" ? (
          // Same column composition as the live PDP (shared PdpBlockColumns), so the merchant
          // approves the layout that actually publishes — not a flat stack of the same blocks.
          <article className="cd-pdp cd-pdp--blocks">
            <PdpBlockColumns doc={doc} data={data} record={record} links={PREVIEW_LINKS} />
          </article>
        ) : (
          renderBlocks(doc, { data, record, links: PREVIEW_LINKS })
        )}
      </main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
