// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
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
import { storeNameFromMatches } from "~/lib/storefront/meta";
import type { BlockDocument } from "~/lib/storebuilder/types";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";

export const meta: MetaFunction = ({ matches }) => {
  const store = storeNameFromMatches(matches);
  const title = `Shop all — ${store}`;
  return [
    { title },
    { name: "description", content: `Browse every product at ${store}.` },
    { property: "og:title", content: title },
  ];
};

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
  return json({ doc, data }, { headers: track });
}

export default function StorefrontHome() {
  const { doc, data } = useLoaderData<typeof loader>();
  return <div className="cd-store__home">{renderBlocks(doc, { data })}</div>;
}
