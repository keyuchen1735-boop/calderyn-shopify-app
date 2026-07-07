// Client fetchers for the Store studio surface. Kept in its own module (not
// client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend, apiSendForm, saveProduct, uploadProductImage } from "./client";
import type {
  StudioState,
  StudioSettings,
  StudioHero,
  StudioProduct,
  StudioGeneration,
  StudioGenerationStatus,
  StudioGenerateReceipt,
  StudioAddedProduct,
  StudioDesignModel,
  StudioVibe,
  StudioExperiment,
  StudioExperimentReport,
  StudioExperimentState,
} from "~/lib/storebuilder/studio-types";

export type {
  StudioState,
  StudioSettings,
  StudioHero,
  StudioProduct,
  StudioGeneration,
  StudioGenerationStatus,
  StudioGenerateReceipt,
  StudioAddedProduct,
  StudioDesignModel,
  StudioVibe,
  StudioExperiment,
  StudioExperimentReport,
  StudioExperimentState,
};

export async function fetchStudio(): Promise<StudioState> {
  return apiGet<StudioState>("/dashboard/api/store");
}

/** Persist the home hero copy (headline + subhead) into the draft doc. */
export async function saveStudioHero(hero: StudioHero): Promise<StudioHero> {
  const data = await apiSend<{ hero: StudioHero }>("POST", "/dashboard/api/store", {
    action: "save-hero",
    headline: hero.headline,
    subhead: hero.subhead,
  });
  return data.hero;
}

/** Set the brand palette's primary/accent color (#rrggbb). */
export async function setStudioAccent(color: string): Promise<string> {
  const data = await apiSend<{ accent: string }>("POST", "/dashboard/api/store", {
    action: "accent",
    color,
  });
  return data.accent;
}

/** Set the storefront design vibe (minimal | bold | warm). */
export async function setStudioVibe(vibe: StudioVibe): Promise<StudioVibe> {
  const data = await apiSend<{ vibe: StudioVibe }>("POST", "/dashboard/api/store", {
    action: "vibe",
    vibe,
  });
  return data.vibe;
}

/** Start a one-at-a-time home-page A/B test. The server picks the concrete
 *  challenger from its deterministic library; name is an optional override. */
export async function startStoreExperiment(spec: {
  kind: "headline" | "vibe";
  name?: string;
}): Promise<StudioExperiment> {
  const data = await apiSend<{ experiment: StudioExperiment }>("POST", "/dashboard/api/store", {
    action: "experiment-start",
    kind: spec.kind,
    ...(spec.name ? { name: spec.name } : {}),
  });
  return data.experiment;
}

/** Decide the running experiment: ship applies the challenger to the live
 *  store; keep/stop retain the champion. Returns the decided experiment with
 *  its final report. */
export async function decideStoreExperiment(
  id: string,
  decision: "ship" | "keep" | "stop",
): Promise<StudioExperiment> {
  const data = await apiSend<{ experiment: StudioExperiment }>("POST", "/dashboard/api/store", {
    action: "experiment-decide",
    id,
    decision,
  });
  return data.experiment;
}

/** Kick off a real store generation. An empty brief generates from the catalog
 *  alone. Awaits the full run — this can take several seconds. */
export async function generateStudioStore(brief: string, model?: StudioDesignModel): Promise<StudioGenerateReceipt> {
  return apiSend<StudioGenerateReceipt>("POST", "/dashboard/api/store", {
    action: "generate",
    brief,
    ...(model ? { model } : {}),
  });
}

/** Generate a store with the merchant's attached images travelling in the SAME
 *  request as the brief (multipart). The server decides what the images are for
 *  (add-as-products / design reference / both) UNLESS `intent` is given — the
 *  needs_intent quick-reply passes it to skip re-classification. An empty brief
 *  generates from the catalog alone. Returns the full receipt, which may be
 *  needs_intent (nothing done), products_added (drafts only, no run), a
 *  soft-degraded generation, or a partial failure carrying created drafts. */
export async function generateStudioStoreWithImages(
  brief: string,
  files: File[],
  model: StudioDesignModel,
  intent?: "products" | "reference" | "both",
): Promise<StudioGenerateReceipt> {
  const form = new FormData();
  form.set("action", "generate");
  if (brief) form.set("brief", brief);
  form.set("model", model);
  if (intent) form.set("intent", intent);
  for (const file of files) form.append("image", file);
  return apiSendForm<StudioGenerateReceipt>("/dashboard/api/store", form);
}

/** Publish every drafted storefront page (the server seeds and publishes the
 *  default home page when nothing is drafted — publishing is never gated). */
export async function publishStudioStore(): Promise<{ publishedAt: string }> {
  return apiSend<{ publishedAt: string }>("POST", "/dashboard/api/store", {
    action: "publish",
  });
}

/** "red-ceramic_mug.v2.jpg" → "Red ceramic mug v2" — a starter title for a
 *  product created from a chat-box image attachment. */
export function productTitleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[a-z0-9]+$/i, "");
  const words = stem.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "New product";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface AddedProduct {
  id: string;
  title: string;
  /** Set when the product was created but its image failed to attach — the
   *  caller must surface the partial add rather than reporting total failure
   *  (a retry would otherwise mint a duplicate product). */
  imageError?: string;
}

/** Turn a chat-box image attachment into a catalog product: create a draft
 *  product titled from the filename, then attach the image. Draft, not active —
 *  price and shipping still need the product editor before it can sell. */
export async function addProductFromImage(file: File): Promise<AddedProduct> {
  const title = productTitleFromFilename(file.name);
  const { id } = await saveProduct({ title, status: "draft", variants: [{}] });
  try {
    await uploadProductImage(id, file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "image upload failed";
    return { id, title, imageError: msg };
  }
  return { id, title };
}
