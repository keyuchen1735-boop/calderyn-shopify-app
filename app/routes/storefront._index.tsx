// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs, MetaFunction, MetaDescriptor } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { ensureVisitorSession } from "~/lib/storefront/visitor-cookie.server";
import { resolveServedExperiment } from "~/lib/experiments/store-experiment.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { storefrontWeatherCondition } from "~/lib/storefront/weather-serve.server";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";
import { renderBlocks } from "~/lib/storebuilder/render";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { buildHomeDraft } from "~/lib/seo/writer.server";
import { safeMetaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import type { BlockDocument } from "~/lib/storebuilder/types";

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Store" }];

interface ExperimentArm {
  /** Set only on arm b — the champion doc renders when this is null. */
  doc: BlockDocument | null;
  experimentId: string | null;
  variantKey: "a" | "b" | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // The visitor session backs live analytics; A/B bucketing resolves through the shared
  // experiments helper, which keys off the COOKIE id only — every surface (this doc swap, the
  // layout's vibe restyle, the PDP variant, the checkout stamps) buckets the same visitor the
  // same way, and a first-ever visit sees the champion unstamped until its cookie lands.
  //
  // None of these reads depend on each other, so they run concurrently.
  const [visitor, published, served] = await Promise.all([
    ensureVisitorSession(request),
    // The published block doc for this shop's home, or the never-blank default (rule 12).
    loadPublishedDoc(shopId, "home").then((doc) => doc ?? defaultHomeDocument()),
    resolveServedExperiment(shopId, request, "home"),
  ]);
  const arm: ExperimentArm = {
    doc: served.variantKey === "b" && served.experiment?.pageKey === "home" ? served.experiment.variantDoc : null,
    experimentId: served.experimentId,
    variantKey: served.variantKey,
  };
  const doc = arm.doc ?? published;
  // Pre-resolve exactly the catalog data the doc's blocks reference (shopId scoping inside).
  // The visitor's own local weather (from their request) floats weather-relevant products up.
  const weatherCondition = await storefrontWeatherCondition(request, shopId);
  const data = await resolveRenderData(doc, shopId, catalog, undefined, weatherCondition);
  // Exposure rides the existing page_view row for BOTH arms; only stamped when a test is running.
  const track = await trackStorefrontEvent(request, shopId, "page_view", {
    experimentId: arm.experimentId,
    variantKey: arm.variantKey,
  }, visitor);
  // SEO/AIO meta + Organization/WebSite JSON-LD. Failure-isolated like the experiment
  // lookup above: a settings-fetch hiccup must never 500 a home page that would
  // otherwise render fine. The home page has no merchant override (only product
  // overrides are written), so there is nothing to layer here.
  let seoMeta: MetaDescriptor[];
  try {
    const [settings, seo] = await Promise.all([getStoreSettings(shopId), getSeoSettings(shopId)]);
    const draft = buildHomeDraft(settings, storefrontOrigin(request));
    seoMeta = safeMetaFromDraft(draft);
    // Google Search Console HTML-tag verification: only the home page needs it, and
    // only when the merchant has pasted a token in Preferences (see Search.tsx).
    if (seo.googleSiteVerification) {
      seoMeta.push({ name: "google-site-verification", content: seo.googleSiteVerification });
    }
  } catch (err) {
    console.error(`[storefront] seo meta build failed for shop ${shopId}:`, err);
    seoMeta = [{ title: "Store" }];
  }
  return json({ doc, data, seoMeta }, { headers: track });
}

export default function StorefrontHome() {
  const { doc, data } = useLoaderData<typeof loader>();
  return <div className="cd-store__home">{renderBlocks(doc, { data })}</div>;
}
