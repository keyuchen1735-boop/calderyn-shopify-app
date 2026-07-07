// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs, MetaFunction, MetaDescriptor } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { ensureVisitorSession } from "~/lib/storefront/visitor-cookie.server";
import { getRunningExperiment, assignArm, type RunningExperiment } from "~/lib/experiments/store-experiment.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { defaultHomeDocument } from "~/lib/storebuilder/default-doc";
import { renderBlocks } from "~/lib/storebuilder/render";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildHomeDraft } from "~/lib/seo/writer.server";
import { metaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import { getSeoOverride } from "~/lib/seo/seo-store.server";
import { applyOverride } from "~/lib/seo/override";
import type { BlockDocument } from "~/lib/storebuilder/types";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Store" }];

interface ExperimentArm {
  /** Set only on arm b — the champion doc renders when this is null. */
  doc: BlockDocument | null;
  vibe: StudioVibe | null;
  experimentId: string | null;
  variantKey: "a" | "b" | null;
}

const NO_ARM: ExperimentArm = { doc: null, vibe: null, experimentId: null, variantKey: null };

/**
 * One-at-a-time home-page A/B lookup (D4), decoupled from the visitor id so it
 * can run in parallel with ensureVisitorSession/loadPublishedDoc. Failure-isolated:
 * a lookup/DB hiccup must never break the home render, so any error degrades to
 * "no test running" exactly like a shop with none.
 */
async function fetchRunningExperimentSafe(shopId: string): Promise<RunningExperiment | null> {
  try {
    return await getRunningExperiment(shopId);
  } catch (err) {
    console.error(`[storefront] experiment lookup failed for shop ${shopId} (serving the champion):`, err);
    return null;
  }
}

/** Bucket the already-fetched experiment against the visitor id — pure/sync,
 *  so it composes with a Promise.all fetch instead of gating it. */
function resolveExperimentArm(experiment: RunningExperiment | null, visitorId: string): ExperimentArm {
  if (!experiment) return NO_ARM;
  const variantKey = assignArm(visitorId, experiment.id);
  if (variantKey === "b") {
    return {
      doc: experiment.variantDoc,
      vibe: experiment.variantSettings?.vibe ?? null,
      experimentId: experiment.id,
      variantKey,
    };
  }
  return { ...NO_ARM, experimentId: experiment.id, variantKey };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // The visitor id backing both live analytics and A/B bucketing (D4). The session is minted
  // once here and threaded into trackStorefrontEvent below (5th arg), so the served arm, the
  // exposure row, and the persisted cd_vid/cd_sid Set-Cookie all key off this one id — including
  // on a visitor's very first-ever hit, when no cookie is on the request yet.
  //
  // None of these three reads depend on each other, so they run concurrently; only the
  // arm assignment (sync, below) needs both the visitor id and the experiment lookup.
  const [visitor, published, experiment] = await Promise.all([
    ensureVisitorSession(request),
    // The published block doc for this shop's home, or the never-blank default (rule 12).
    loadPublishedDoc(shopId, "home").then((doc) => doc ?? defaultHomeDocument()),
    fetchRunningExperimentSafe(shopId),
  ]);
  const arm = resolveExperimentArm(experiment, visitor.visitorId);
  const doc = arm.doc ?? published;
  // Pre-resolve exactly the catalog data the doc's blocks reference (shopId scoping inside).
  const data = await resolveRenderData(doc, shopId, catalog);
  // Exposure rides the existing page_view row for BOTH arms; only stamped when a test is running.
  const track = await trackStorefrontEvent(request, shopId, "page_view", {
    experimentId: arm.experimentId,
    variantKey: arm.variantKey,
  }, visitor);
  // SEO/AIO meta + Organization/WebSite JSON-LD. Failure-isolated like the experiment
  // lookup above: a settings-fetch hiccup must never 500 a home page that would
  // otherwise render fine.
  let seoMeta: MetaDescriptor[];
  try {
    const settings = await getStoreSettings(shopId);
    const draft = buildHomeDraft(settings, storefrontOrigin(request));
    const override = await getSeoOverride(shopId, "home", "home");
    seoMeta = metaFromDraft(applyOverride(draft, override));
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
