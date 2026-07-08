// Client fetchers for the Store studio surface. Kept in its own module (not
// client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend, apiSendForm, DashboardApiError, saveProduct, uploadProductImage } from "./client";
import {
  parseBuildEvent,
  type BuildStage,
  type StudioState,
  type StudioSettings,
  type StudioHero,
  type StudioProduct,
  type StudioGeneration,
  type StudioGenerationStatus,
  type StudioGenerateReceipt,
  type StudioAddedProduct,
  type StudioDesignModel,
  type StudioVibe,
  type StudioExperiment,
  type StudioExperimentReport,
  type StudioExperimentState,
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

/** Run ONE unit of post-build imagery fill (hero first, then one pending product). The caller
 *  loops until `done`, reloading the preview between calls, so no single request nears the
 *  serverless limit and images appear incrementally. */
export async function fillStoreImages(): Promise<{ done: boolean; remaining: number }> {
  return apiSend<{ done: boolean; remaining: number }>("POST", "/dashboard/api/store/images", {});
}

/** Archive every active sample product (calderyn:sample); returns how many were cleared. */
export async function clearStoreSamples(): Promise<{ removed: number }> {
  return apiSend<{ removed: number }>("POST", "/dashboard/api/store/samples", {});
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

/** Transport/parse failure of the streaming generate path — the caller may fall
 *  back to the non-streaming endpoint. Guard refusals and generation failures
 *  arrive as DashboardApiError instead and are FINAL (a fallback would re-bill). */
export class StudioStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioStreamError";
  }
}

/** Streaming twin of generateStudioStore: POSTs to the NDJSON endpoint, forwards
 *  each real build stage to `onStage`, resolves with the final receipt. */
export async function generateStudioStoreStream(
  brief: string,
  model: StudioDesignModel,
  onStage: (stage: BuildStage) => void,
): Promise<StudioGenerateReceipt> {
  let res: Response;
  try {
    res = await fetch("/dashboard/api/store/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(typeof location !== "undefined" ? { Origin: location.origin } : {}),
      },
      body: JSON.stringify({ ...(brief.trim() ? { brief: brief.trim() } : {}), model }),
    });
  } catch (err) {
    throw new StudioStreamError(err instanceof Error ? err.message : "stream request failed");
  }
  if (!res.ok) {
    let code = "generation_failed";
    let message = "Store generation failed.";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // keep the generic mapping; the status code still tells the story
    }
    throw new DashboardApiError(res.status, code, message);
  }
  if (!res.body) throw new StudioStreamError("response had no stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line: string): StudioGenerateReceipt | undefined => {
    const ev = parseBuildEvent(line);
    if (!ev) return undefined; // tolerate unknown lines (forward compatibility)
    if (ev.stage === "done") return ev.receipt;
    if (ev.stage === "error") throw new DashboardApiError(502, "generation_failed", ev.message);
    onStage(ev.stage);
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const receipt = handleLine(line);
        if (receipt) {
          reader.cancel().catch(() => {});
          return receipt;
        }
      }
    }
  } catch (err) {
    if (err instanceof DashboardApiError) throw err;
    throw new StudioStreamError(err instanceof Error ? err.message : "stream read failed");
  }
  const rest = buf.trim();
  if (rest) {
    const receipt = handleLine(rest);
    if (receipt) return receipt;
  }
  throw new StudioStreamError("stream ended without a result");
}
