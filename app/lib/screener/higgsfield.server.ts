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
// Contract verified against the official @higgsfield/client v2 source
// (github.com/higgsfield-ai/higgsfield-js: src/v2/client.ts + src/v2/types.ts):
// POST /v1/text2image/soul with the SoulText2ImageInput fields flat in the body,
// auth `Authorization: Key <key>:<secret>`, poll GET /requests/{id}/status until
// a terminal status, images returned as `images: [{url}]`.
const DEFAULT_MODEL = "v1/text2image/soul";
const TERMINAL = new Set(["completed", "nsfw", "cancelled", "failed"]);
// Soul accepts only these batch sizes (SDK BatchSize: SINGLE=1, QUAD=4).
const soulBatchSize = (count: number): 1 | 4 => (count > 1 ? 4 : 1);

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
      // The platform reports errors as {detail} — a string ("Invalid
      // credentials") or a validation array of {msg} objects.
      const e = (await res.json()) as {
        detail?: string | Array<{ msg?: string }>;
        message?: string;
        error?: string;
      };
      const fromDetail = Array.isArray(e?.detail)
        ? e.detail.map((d) => d?.msg).filter(Boolean).join("; ")
        : e?.detail;
      detail = fromDetail || e?.message || e?.error || detail;
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
  opts: {
    fetchImpl?: FetchLike;
    model?: string;
    pollDelayMs?: number;
    timeoutMs?: number;
    /** A SoulSize string like "1536x1536" — controls the rendered aspect. */
    widthAndHeight?: string;
  } = {},
): GenerateImageFn {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const widthAndHeight = opts.widthAndHeight ?? "1536x1536";
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

    const body: Record<string, unknown> = {
      prompt,
      width_and_height: widthAndHeight,
      quality: "1080p",
      batch_size: soulBatchSize(count),
    };
    if (referenceImageUrl) {
      body.image_reference = { type: "image_url", image_url: referenceImageUrl };
    }

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
    req.extraDirection ? `\nArt direction from the merchant: ${req.extraDirection}` : "",
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
