// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data as dataResponse , useLoaderData } from "react-router";

import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";
import { renderBlocks } from "~/lib/storebuilder/render";
import { storeNameFromMatches } from "~/lib/storefront/meta";

export const meta: MetaFunction = ({ matches }) => {
  const store = storeNameFromMatches(matches);
  const title = `Shop all — ${store}`;
  return [
    { title },
    { name: "description", content: `Browse every product at ${store}.` },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // The published block doc for this shop's home, or the never-blank default (rule 12).
  const doc = (await loadPublishedDoc(shopId, "home")) ?? defaultHomeDocument();
  // Pre-resolve exactly the catalog data the doc's blocks reference (shopId scoping inside).
  const data = await resolveRenderData(doc, shopId, catalog);
  const track = await trackStorefrontEvent(request, shopId, "page_view");
  return dataResponse({ doc, data }, { headers: track });
}

export default function StorefrontHome() {
  const { doc, data } = useLoaderData<typeof loader>();
  return <div className="cd-store__home">{renderBlocks(doc, { data })}</div>;
}
