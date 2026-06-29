// app/routes/dashboard.builder.preview.tsx
// Read-only preview of the generated DRAFT store across home/collection/PDP (no editor yet).
// Uses the same renderBlocks as the live storefront; templates preview against a sample record.
// Phase C adds the imagery-candidate list + enhance action here.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getSessionOrRedirect } from "~/lib/dashboard/session.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { loadDraftDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import type { BlockDocument, RenderData, RenderContext } from "~/lib/storebuilder/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSessionOrRedirect(request);
  const shopId = session.shopId;
  const catalog = getCatalog();
  const [products, collections] = [await catalog.listProducts(shopId), await catalog.listCollections(shopId)];
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
  });
}

type Pane = { doc: BlockDocument; data: RenderData; record?: RenderContext["record"] } | null;

export default function BuilderPreview() {
  const { home, collection, pdp } = useLoaderData<typeof loader>() as { home: Pane; collection: Pane; pdp: Pane };
  const panes: [string, Pane][] = [["Home", home], ["Collection", collection], ["PDP", pdp]];
  const any = panes.some(([, p]) => p);
  return (
    <div className="cd-builder-preview">
      <h1>Generated store (draft)</h1>
      {!any ? <p>No draft yet — generate your store first.</p> : null}
      {panes.map(([label, pane]) =>
        pane ? (
          <section key={label} className="cd-builder-preview__pane">
            <h2>{label}</h2>
            <div className="cd-store__home">{renderBlocks(pane.doc, { data: pane.data, record: pane.record })}</div>
          </section>
        ) : null,
      )}
    </div>
  );
}
