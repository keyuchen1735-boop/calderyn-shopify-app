// app/lib/screener/higgsfield.server.ts
// Image generation as a second CreativeGenerator mode. The generator builds an
// image prompt from the scored flaws and hands it to a DI'd GenerateImageFn; the
// produced image swaps into the creative (copy preserved) and is judged by the
// SAME re-score gate as copy variants — generation is never trusted blindly.
import type { CreativeGenerator, GenerateRequest } from "./generate.server";
import type { GeneratedCandidate } from "./types";

/** DI seam: submit a generation and return the produced public asset URLs. */
export type GenerateImageFn = (args: {
  prompt: string;
  referenceImageUrl: string | null;
  count: number;
}) => Promise<string[]>;

/** Minimal fetch shape, so tests can inject a fake without the DOM Response type. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const HF_BASE = "https://platform.higgsfield.ai";
// VERIFY at first live call (cloud.higgsfield.ai docs): the REST model path and the
// reference-image body field. `marketing_studio_image` is the MCP catalog id; the
// REST path is namespaced like `higgsfield-ai/<model>/<variant>`.
const DEFAULT_MODEL = "higgsfield-ai/marketing-studio/image";
const TERMINAL = new Set(["completed", "nsfw", "cancelled", "failed"]);

const defaultFetch: FetchLike = (url, init) => fetch(url, init);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function hfRequest(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    let detail = String(res.status);
    try {
      const e = (await res.json()) as { message?: string; error?: string };
      detail = e?.message ?? e?.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Higgsfield API error: ${detail}`);
  }
  return res.json();
}

function extractImageUrls(payload: unknown): string[] {
  const p = payload as { images?: unknown; result?: { images?: unknown } };
  const arr = Array.isArray(p.images)
    ? p.images
    : Array.isArray(p.result?.images)
      ? (p.result?.images as unknown[])
      : [];
  return (arr as unknown[])
    .map((i) => (i as { url?: unknown }).url)
    .filter((u): u is string => typeof u === "string");
}

/**
 * Real `GenerateImageFn`: submit `POST /{model}`, poll `GET /requests/{id}/status`
 * to a terminal state, return the completed image URLs. Auth + creds from env. The
 * HTTP layer is injectable so tests never hit the network.
 */
export function higgsfieldImageClient(
  opts: { fetchImpl?: FetchLike; model?: string; pollDelayMs?: number; timeoutMs?: number } = {},
): GenerateImageFn {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const pollDelayMs = opts.pollDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  return async ({ prompt, referenceImageUrl, count }) => {
    const key = process.env.HIGGSFIELD_API_KEY;
    const secret = process.env.HIGGSFIELD_API_SECRET;
    if (!key || !secret) {
      throw new Error(
        "Higgsfield credentials missing: set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.",
      );
    }
    const auth = `Key ${key}:${secret}`;

    const body: Record<string, unknown> = { prompt, count };
    if (referenceImageUrl) body.image_url = referenceImageUrl; // VERIFY field name

    const submitted = await hfRequest(fetchImpl, `${HF_BASE}/${model}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const requestId =
      (submitted as { request_id?: string }).request_id ?? (submitted as { id?: string }).id;
    if (!requestId) throw new Error("Higgsfield submit did not return a request id");

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await hfRequest(fetchImpl, `${HF_BASE}/requests/${requestId}/status`, {
        method: "GET",
        headers: { Authorization: auth },
      });
      const state = String((status as { status?: unknown }).status ?? "").toLowerCase();
      if (state === "completed") return extractImageUrls(status).slice(0, count);
      if (TERMINAL.has(state)) {
        const msg = (status as { error?: string }).error ?? state;
        throw new Error(`Higgsfield generation ${state}: ${msg}`);
      }
      if (Date.now() >= deadline) throw new Error("Higgsfield generation timed out");
      await sleep(pollDelayMs);
    }
  };
}

/** Build an image-generation prompt from the creative's weakest dimensions. */
export function buildImagePrompt(req: GenerateRequest): string {
  const weak = req.weakMetrics.length
    ? req.weakMetrics.map((m) => `- ${m.label} (${m.score}/100): ${m.reasoning}`).join("\n")
    : "- (no specific weak dimensions flagged)";
  const refs = req.styleRefs.length
    ? `\nMatch the look of the merchant's winning ads: ${req.styleRefs.join(", ")}.`
    : "";
  return [
    "Generate an improved advertising image for this product, keeping the same product",
    "identity as the reference image — do NOT invent a different product.",
    `\nHeadline context: ${req.input.headline}`,
    `Audience: ${req.input.audience}`,
    `\nFix these weak dimensions:\n${weak}`,
    req.tips.length ? `\nApply these fixes: ${req.tips.join("; ")}` : "",
    refs,
  ].join("\n");
}

/**
 * Image generator. `available()` gates on both Higgsfield credentials so the route
 * shows a "connect" state until they are set; the actual HTTP call is injected so
 * tests never hit the network.
 */
export function imageGenerator(deps: { generateImage: GenerateImageFn }): CreativeGenerator {
  return {
    mode: "image",
    available: () =>
      Boolean(process.env.HIGGSFIELD_API_KEY) && Boolean(process.env.HIGGSFIELD_API_SECRET),
    async generate(req): Promise<GeneratedCandidate[]> {
      const urls = await deps.generateImage({
        prompt: buildImagePrompt(req),
        referenceImageUrl: req.input.imageUrl,
        count: req.count,
      });
      const targeted =
        req.weakMetrics.map((m) => m.label).join(", ") || "overall creative quality";
      return urls.map((url) => ({
        input: { ...req.input, imageUrl: url },
        rationale: `New image targeting: ${targeted}.`,
      }));
    },
  };
}
