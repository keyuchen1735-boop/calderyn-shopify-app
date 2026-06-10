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
// Contract verified against the official platform docs
// (docs.higgsfield.ai/docs/how-to/introduction + docs/guides/images):
// POST /{model_id} with {prompt, aspect_ratio, resolution} flat in the body and
// media inputs as flat url strings (image_url), auth `Authorization: Key
// <key>:<secret>`, poll GET /requests/{id}/status until a terminal status,
// images returned as `images: [{url}]`. The platform has no batch field — one
// request produces one image, so batches are parallel submissions.
const DEFAULT_MODEL = "higgsfield-ai/soul/standard";
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
      // The platform reports errors as {detail} — a string ("Invalid
      // credentials") or a validation array of {loc, msg} objects. Keep the
      // loc path: it names the field a 422 is complaining about.
      const e = (await res.json()) as {
        detail?: string | Array<{ msg?: string; loc?: Array<string | number> }>;
        message?: string;
        error?: string;
      };
      const fromDetail = Array.isArray(e?.detail)
        ? e.detail
            .map((d) => [d?.loc?.map(String).join("."), d?.msg].filter(Boolean).join(": "))
            .filter(Boolean)
            .join("; ")
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
    /** An aspect_ratio string like "1:1", "3:4", "9:16" — controls the rendered aspect. */
    aspectRatio?: string;
    /** Output resolution; "720p" is the documented platform value. */
    resolution?: string;
  } = {},
): GenerateImageFn {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const aspectRatio = opts.aspectRatio ?? "1:1";
  const resolution = opts.resolution ?? "720p";
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
      aspect_ratio: aspectRatio,
      resolution,
    };
    if (referenceImageUrl) body.image_url = referenceImageUrl;

    // One deadline for the whole call, not per request — count>1 must not
    // stretch the caller's timeout budget.
    const deadline = Date.now() + timeoutMs;

    const generateOne = async (): Promise<string[]> => {
      const submitted = await hfRequest(fetchImpl, `${HF_BASE}/${model}`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const requestId =
        (submitted as { request_id?: string }).request_id ?? (submitted as { id?: string }).id;
      if (!requestId) throw new Error("Higgsfield submit did not return a request id");

      for (;;) {
        const status = await hfRequest(fetchImpl, `${HF_BASE}/requests/${requestId}/status`, {
          method: "GET",
          headers: { Authorization: auth },
        });
        const state = String((status as { status?: unknown }).status ?? "").toLowerCase();
        if (state === "completed") return extractImageUrls(status);
        if (TERMINAL.has(state)) {
          const msg = (status as { error?: string }).error ?? state;
          throw new Error(`Higgsfield generation ${state}: ${msg}`);
        }
        if (Date.now() >= deadline) throw new Error("Higgsfield generation timed out");
        await sleep(pollDelayMs);
      }
    };

    // allSettled, not all: with parallel submissions one nsfw/failed request
    // must not discard the sibling images that were already produced (and
    // billed). Surface the failure only when nothing succeeded.
    const settled = await Promise.allSettled(
      Array.from({ length: Math.max(1, count) }, () => generateOne()),
    );
    const urls = settled
      .filter((s): s is PromiseFulfilledResult<string[]> => s.status === "fulfilled")
      .flatMap((s) => s.value);
    if (urls.length === 0) {
      const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      if (failed) throw failed.reason;
    }
    return urls.slice(0, count);
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
