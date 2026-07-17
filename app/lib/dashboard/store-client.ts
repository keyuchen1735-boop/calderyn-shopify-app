// Client fetchers for the Store studio surface. Kept in its own module (not
// client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend, apiSendForm, DashboardApiError, redirectToLogin, saveProduct, uploadProductImage } from "./client";
import { throwIfVersionSkew } from "./version-skew";
import {
  parseBuildEvent,
  type BuildStage,
  type Runtime1BuildStage,
  type StudioBundleBuildReceipt,
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
  type StudioExperimentKind,
  type StudioSection,
} from "~/lib/storebuilder/studio-types";
import type { StoreDesignRequest, StoreDesignResolution } from "~/lib/storefront-bundle/types";
import type { PreviewEditContext, StorefrontEditReceipt, StorefrontEditStage, StorefrontStartOverReceipt } from "~/lib/storefront-edit/types";

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
  StudioSection,
};

export async function fetchStudio(): Promise<StudioState> {
  return apiGet<StudioState>("/dashboard/api/store");
}

/** Resolve prompt + current server-side catalog evidence without changing the store. */
export async function resolveStudioDesign(request: StoreDesignRequest): Promise<StoreDesignResolution> {
  return apiSend<StoreDesignResolution>("POST", "/dashboard/api/store/resolve", request);
}

export async function editStudioStorefront(input: {
  prompt: string;
  expectedDraftVersionId: string;
  context?: PreviewEditContext;
}): Promise<StorefrontEditReceipt | StorefrontStartOverReceipt> {
  return apiSend("POST", "/dashboard/api/store", { action: "edit", ...input });
}

export async function editStudioStorefrontStream(
  input: { prompt: string; expectedDraftVersionId: string; context?: PreviewEditContext; model?: StudioDesignModel },
  onStage: (stage: StorefrontEditStage) => void,
  signal?: AbortSignal,
): Promise<StorefrontEditReceipt | StorefrontStartOverReceipt> {
  let response: Response;
  try {
    response = await fetch("/dashboard/api/store", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(typeof location !== "undefined" ? { Origin: location.origin } : {}),
      },
      body: JSON.stringify({ action: "edit", ...input }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    throw new StudioStreamError(error instanceof Error ? error.message : "edit stream request failed");
  }
  throwIfVersionSkew(response);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new DashboardApiError(response.status, body.error ?? "storefront_edit_failed", body.message ?? "Storefront edit failed.");
  }
  if (!response.body) throw new StudioStreamError("edit response had no stream body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (line: string): StorefrontEditReceipt | StorefrontStartOverReceipt | undefined => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (["compiling", "validating", "proofing", "installing"].includes(String(event.stage))) {
      onStage(event.stage as StorefrontEditStage);
    } else if (event.stage === "installed" && event.receipt && typeof event.receipt === "object") {
      return event.receipt as StorefrontEditReceipt;
    } else if (event.stage === "start_over") {
      const receipt = event.receipt && typeof event.receipt === "object" ? event.receipt as Record<string, unknown> : null;
      return { status: "start_over", mode: receipt?.mode === "auto" ? "auto" : "custom" };
    } else if (event.stage === "error") {
      throw new DashboardApiError(
        typeof event.status === "number" ? event.status : 502,
        typeof event.code === "string" ? event.code : "storefront_edit_failed",
        typeof event.message === "string" ? event.message : "Storefront edit failed.",
      );
    }
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const receipt = handleLine(line);
        if (receipt) return receipt;
      }
    }
    const receipt = buffer.trim() ? handleLine(buffer.trim()) : undefined;
    if (receipt) return receipt;
  } catch (error) {
    if (error instanceof DashboardApiError) throw error;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    throw new StudioStreamError(error instanceof Error ? error.message : "edit stream read failed");
  }
  throw new StudioStreamError("edit stream ended without an installed storefront");
}

export async function undoStudioStorefrontEdit(input: {
  targetVersionId: string;
  expectedDraftVersionId: string;
}): Promise<{ status: "installed"; versionId: string; undoneVersionId: string }> {
  return apiSend("POST", "/dashboard/api/store", { action: "undo-edit", ...input });
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
  kind: StudioExperimentKind;
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
  signal?: AbortSignal,
): Promise<StudioGenerateReceipt> {
  const form = new FormData();
  form.set("action", "generate");
  if (brief) form.set("brief", brief);
  form.set("model", model);
  if (intent) form.set("intent", intent);
  for (const file of files) form.append("image", file);
  return apiSendForm<StudioGenerateReceipt>("/dashboard/api/store", form, signal);
}

export interface DesignerPageEvent {
  page: string;
  index: number;
  total: number;
  reply: string;
}

export interface DesignerTurnResult {
  reply: string;
  changed: boolean;
  rejectedEdits: number;
}

/** One conversational turn against the hidden designer engine (Labs). Edit
 *  turns answer as JSON; the first build streams NDJSON page events — each
 *  finished page fires onPage so the merchant sees progress, and the final
 *  done event resolves the promise. */
export async function sendDesignerMessage(input: {
  message: string;
  page?: string;
  model?: StudioDesignModel;
  mode?: "template" | "scratch";
  onPage?: (event: DesignerPageEvent) => void;
  signal?: AbortSignal;
}): Promise<DesignerTurnResult> {
  const { onPage, signal, ...body } = input;
  const res = await fetch("/dashboard/api/designer", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(typeof location !== "undefined" ? { Origin: location.origin } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  // A 401 means the session lapsed; recover the same way every other dashboard
  // call does instead of surfacing a dead-end error in the chat.
  if (res.status === 401) redirectToLogin();
  throwIfVersionSkew(res);
  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("ndjson")) {
    const data = (await res.json().catch(() => null)) as
      | (DesignerTurnResult & { error?: string; message?: string })
      | null;
    if (!res.ok || !data || typeof data.reply !== "string") {
      throw new DashboardApiError(res.status, data?.error ?? "designer_failed", data?.message ?? "The designer couldn't process that.");
    }
    return { reply: data.reply, changed: data.changed === true, rejectedEdits: data.rejectedEdits ?? 0 };
  }

  if (!res.body) throw new DashboardApiError(502, "designer_stream_failed", "The build stream had no body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: DesignerTurnResult | null = null;
  const handleLine = (line: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.kind === "page" && typeof event.reply === "string") {
      onPage?.({
        page: String(event.page ?? ""),
        index: Number(event.index ?? 0),
        total: Number(event.total ?? 0),
        reply: event.reply,
      });
    } else if (event.kind === "done" && typeof event.reply === "string") {
      done = { reply: event.reply, changed: event.changed === true, rejectedEdits: Number(event.rejectedEdits ?? 0) };
    } else if (event.kind === "error") {
      throw new DashboardApiError(502, "designer_build_failed", typeof event.message === "string" ? event.message : "The build failed partway.");
    }
  };
  try {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(line);
      }
    }
    const rest = buffer.trim();
    if (rest) handleLine(rest);
  } catch (err) {
    // A DashboardApiError (an {kind:"error"} event) carries real intent; a raw
    // read failure (network drop) becomes the "pages are saved" message.
    if (err instanceof DashboardApiError) throw err;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    throw new DashboardApiError(502, "designer_stream_failed", "The build lost its connection. Finished pages are saved; send another message to continue.");
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!done) throw new DashboardApiError(502, "designer_stream_failed", "The build stream ended early. Finished pages are saved.");
  return done;
}

/** Publish every drafted storefront page after the tenant domain is ready. The
 *  server seeds and publishes the default home page when nothing is drafted. */
export async function publishStudioStore(): Promise<{ publishedAt: string; storefrontUrl: string }> {
  return apiSend<{ publishedAt: string; storefrontUrl: string }>("POST", "/dashboard/api/store", {
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

/** Transport/parse failure of the streaming generate path — the caller may fall
 *  back to the non-streaming endpoint. Guard refusals and generation failures
 *  arrive as DashboardApiError instead and are FINAL (a fallback would re-bill). */
export class StudioStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioStreamError";
  }
}

/**
 * Runtime-1 build stream. The server reruns routing against fresh catalog
 * evidence; its routing event is authoritative and installation is terminal.
 */
export async function buildStudioStoreStream(
  designRequest: StoreDesignRequest,
  onStage: (stage: Runtime1BuildStage, event: ReturnType<typeof parseBuildEvent>) => void,
  recommendedResolution?: StoreDesignResolution,
  signal?: AbortSignal,
  model?: StudioDesignModel,
): Promise<StudioBundleBuildReceipt> {
  let res: Response;
  try {
    res = await fetch("/dashboard/api/store/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(typeof location !== "undefined" ? { Origin: location.origin } : {}),
      },
      body: JSON.stringify({
        designRequest,
        ...(recommendedResolution ? { recommendedResolution } : {}),
        ...(model ? { model } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    throw new StudioStreamError(err instanceof Error ? err.message : "stream request failed");
  }
  throwIfVersionSkew(res);
  if (!res.ok) {
    let code = "storefront_build_failed";
    let message = "Storefront build failed.";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (typeof body.error === "string") code = body.error;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // Keep the stable generic mapping.
    }
    throw new DashboardApiError(res.status, code, message);
  }
  if (!res.body) throw new StudioStreamError("response had no stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (line: string): StudioBundleBuildReceipt | undefined => {
    const event = parseBuildEvent(line);
    if (!event) return undefined;
    if (event.stage === "installed") return event.receipt;
    if (event.stage === "error") {
      throw new DashboardApiError(event.status ?? 502, event.code ?? "storefront_build_failed", event.message);
    }
    if (["routing", "applying_recipe", "generating_original", "compiling", "validating", "proofing"].includes(event.stage)) {
      onStage(event.stage as Runtime1BuildStage, event);
    }
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
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
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    throw new StudioStreamError(err instanceof Error ? err.message : "stream read failed");
  }
  const rest = buffer.trim();
  if (rest) {
    const receipt = handleLine(rest);
    if (receipt) return receipt;
  }
  throw new StudioStreamError("stream ended without an installed storefront");
}

/** Compatibility wrapper for older callers. The legacy designer no longer owns
 * this endpoint; prompts enter the same recipe/custom runtime-1 router as the
 * main studio build action. */
export async function generateStudioStoreStream(
  brief: string,
  model: StudioDesignModel,
  onStage: (stage: BuildStage) => void,
): Promise<StudioGenerateReceipt> {
  const receipt = await buildStudioStoreStream(
    { prompt: brief.trim(), mode: "auto" },
    (stage) => onStage(stage),
    undefined,
    undefined,
    model,
  );
  return { runId: receipt.versionId, status: "draft" };
}

/** Move one home section up or down; returns the new section order. */
export async function moveStoreSection(id: string, direction: "up" | "down"): Promise<StudioSection[]> {
  const data = await apiSend<{ sections: StudioSection[] }>("POST", "/dashboard/api/store", {
    action: "section-move",
    id,
    direction,
  });
  return data.sections;
}

/** Remove one home section; returns the new section order. */
export async function removeStoreSection(id: string): Promise<StudioSection[]> {
  const data = await apiSend<{ sections: StudioSection[] }>("POST", "/dashboard/api/store", {
    action: "section-remove",
    id,
  });
  return data.sections;
}

/** Regenerate one design section with the design model (optional instruction).
 *  Awaits the full model call — can take several seconds. */
export async function regenerateStoreSection(id: string, instruction?: string): Promise<StudioSection[]> {
  const data = await apiSend<{ sections: StudioSection[] }>("POST", "/dashboard/api/store", {
    action: "section-regenerate",
    id,
    ...(instruction ? { instruction } : {}),
  });
  return data.sections;
}
