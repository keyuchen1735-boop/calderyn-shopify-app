// app/routes/dashboard.builder.preview.tsx
// Read-only preview of the generated DRAFT store across home/collection/PDP (no editor yet).
// Uses the same renderBlocks as the live storefront; templates preview against a sample record.
// Also hosts the imagery-candidate list + enhance action (generate → own → override).
import type { LoaderFunctionArgs, ActionFunctionArgs, LinksFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { requireVerifiedSession } from "~/lib/dashboard/session.server";
import { requireSameOrigin } from "~/lib/dashboard/http.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { loadDraftDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { PdpBlockColumns } from "~/lib/storebuilder/pdp-layout";
import type { BlockDocument, RenderData, RenderContext } from "~/lib/storebuilder/types";
import { findImprovableListings } from "~/lib/storegen/imagery/detector";
import { enhanceListing } from "~/lib/storegen/imagery/asset.server";
import type { ImprovableListing } from "~/lib/storegen/imagery/detector";

// The panes render with the real storefront renderer, so they need the real storefront
// stylesheet — otherwise the PDP column layout below has no grid to compose into.
export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireVerifiedSession(request);
  const shopId = session.shopId;
  const catalog = getCatalog();
  const products = await catalog.listProducts(shopId);
  const collections = await catalog.listCollections(shopId);
  const candidates = findImprovableListings(products);
  const url = new URL(request.url);
  const enhanceError = url.searchParams.get("enhanceError") === "1";
  const generateFailed = url.searchParams.get("status") === "failed";
  const sample: RenderContext["record"] = { product: products[0], collection: collections[0] };

  async function previewFor(page: "home" | "collection" | "pdp") {
    const doc = await loadDraftDoc(shopId, page);
    if (!doc) return null;
    const record = page === "home" ? undefined : sample;
    const data = await resolveRenderData(doc, shopId, catalog, record);
    return { doc, data, record };
  }
  return json({
    home: await previewFor("home"),
    collection: await previewFor("collection"),
    pdp: await previewFor("pdp"),
    candidates,
    enhanceError,
    generateFailed,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  // Match the dashboard.api.* convention: same-origin (CSRF) + email-verified.
  // enhanceListing spends metered image-generation credits, so gate it.
  requireSameOrigin(request);
  const session = await requireVerifiedSession(request);
  const form = await request.formData();
  const productId = form.get("productId");
  if (typeof productId !== "string" || !productId) throw new Response("productId required", { status: 400 });
  const product = (await getCatalog().listProducts(session.shopId)).find((p) => p.id === productId);
  if (!product) throw new Response("unknown product", { status: 404 });
  const result = await enhanceListing(session.shopId, product); // selected listing only — never the whole catalog
  // Surface a failed generation back to the merchant instead of redirecting silently (rule 12).
  return redirect(result.status === "failed" ? "/dashboard/builder/preview?enhanceError=1" : "/dashboard/builder/preview");
}

type Pane = { doc: BlockDocument; data: RenderData; record?: RenderContext["record"] } | null;

export default function BuilderPreview() {
  const { home, collection, pdp, candidates, enhanceError, generateFailed } = useLoaderData<typeof loader>() as {
    home: Pane; collection: Pane; pdp: Pane; candidates: ImprovableListing[]; enhanceError: boolean; generateFailed: boolean;
  };
  const panes: [string, Pane][] = [["Home", home], ["Collection", collection], ["PDP", pdp]];
  const any = panes.some(([, p]) => p);
  return (
    <div className="cd-builder-preview">
      <h1>Generated store (draft)</h1>
      {generateFailed ? (
        <p className="cd-builder-preview__error">
          We couldn&apos;t reach the design engine, so this draft is a starter layout — not your generated design. Try again in a moment.
        </p>
      ) : null}
      {enhanceError ? (
        <p className="cd-builder-preview__error">Image generation failed for that listing — check Gemini configuration.</p>
      ) : null}
      {!any ? <p>No draft yet — generate your store first.</p> : null}
      {panes.map(([label, pane]) =>
        pane ? (
          <section key={label} className="cd-builder-preview__pane">
            <h2>{label}</h2>
            {label === "PDP" ? (
              // Same column composition as the live PDP (shared PdpBlockColumns), so the draft
              // reads like the page that will publish — not a flat stack of the same blocks.
              <article className="cd-pdp cd-pdp--blocks">
                <PdpBlockColumns doc={pane.doc} data={pane.data} record={pane.record} />
              </article>
            ) : (
              <div className="cd-store__home">{renderBlocks(pane.doc, { data: pane.data, record: pane.record })}</div>
            )}
          </section>
        ) : null,
      )}
      <section className="cd-builder-preview__candidates">
        <h2>Improve these listings</h2>
        {candidates.length === 0 ? <p>No listings need imagery help.</p> : null}
        {candidates.map((c: { productId: string; title: string; reason: string }) => (
          <Form method="post" key={c.productId} className="cd-candidate">
            <span>{c.title} — {c.reason}</span>
            <input type="hidden" name="productId" value={c.productId} />
            <button type="submit">Enhance</button>
          </Form>
        ))}
      </section>
    </div>
  );
}
