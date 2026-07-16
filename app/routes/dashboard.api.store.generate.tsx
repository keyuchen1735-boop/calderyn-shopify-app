// app/routes/dashboard.api.store.generate.tsx
// Runtime-1 storefront build stream. Real recipe/original-compiler stages are
// streamed to the studio chat as NDJSON
// lines while the merchant waits, ending with the receipt (or an in-band error
// line; the HTTP status is already committed once the stream starts). Guard and
// validation failures reject as plain JSON BEFORE the stream opens, so quota and
// rate-limit errors keep their proper status codes.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { quotaTrusted } from "~/lib/ai-quota.server";
import { STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import { parseStoreDesignRequest } from "~/lib/storefront-bundle/routing";
import {
  buildStorefrontDesign,
  prepareStorefrontDesignBuild,
  StorefrontBuildError,
  type StorefrontBuildEvent,
} from "~/lib/storefront-bundle/build.server";
import type { StoreDesignResolution } from "~/lib/storefront-bundle/types";
import { StorefrontReleaseError } from "~/lib/storefront-bundle/release.server";

export const config = { maxDuration: 800 };

function buildFailure(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof StorefrontBuildError || error instanceof StorefrontReleaseError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return {
    code: "storefront_build_failed",
    message: "Storefront build failed. Your current draft was not changed.",
    status: 502,
  };
}

function recommendedResolution(value: unknown): StoreDesignResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const resolution = value as Record<string, unknown>;
  if (
    (resolution.kind !== "recipe" && resolution.kind !== "custom") ||
    typeof resolution.catalogFingerprint !== "string" ||
    !Array.isArray(resolution.breakdown) ||
    !Array.isArray(resolution.reasons)
  ) return undefined;
  return value as StoreDesignResolution;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonError(422, "invalid_body");
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_body");
  }

  const requestInput = Object.hasOwn(body, "designRequest")
    ? body.designRequest
    : {
        prompt: typeof body.brief === "string" ? body.brief : "",
        mode: "auto",
      };
  const parsed = parseStoreDesignRequest(requestInput, STORE_TEMPLATE_REGISTRY);
  if (!parsed.ok) return jsonError(422, parsed.error);
  if (!(await rateLimit(`storefront-build:${session.shopId}`, 10, 60_000))) {
    return jsonError(429, "rate_limited", "Too many storefront builds. Please wait a moment.");
  }

  let prepared;
  try {
    prepared = await prepareStorefrontDesignBuild({
      shopId: session.shopId,
      request: parsed.value,
      trusted: quotaTrusted(session),
    });
  } catch (error) {
    const failure = buildFailure(error);
    return jsonError(failure.status, failure.code, failure.message);
  }
  const encoder = new TextEncoder();
  let cancelled = false;
  const generationController = new AbortController();
  const abortFromRequest = () => generationController.abort(request.signal.reason);
  if (request.signal.aborted) generationController.abort(request.signal.reason);
  else request.signal.addEventListener("abort", abortFromRequest, { once: true });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const write = (value: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      const send = (event: StorefrontBuildEvent | { stage: "error"; code: string; status: number; message: string }) => write(event);
      heartbeat = setInterval(() => {
        try { write({ stage: "heartbeat" }); } catch { clearInterval(heartbeat); }
      }, 15_000);
      try {
        await buildStorefrontDesign({
          shopId: session.shopId,
          actorId: session.userId,
          request: parsed.value,
          recommendedResolution: recommendedResolution(body.recommendedResolution),
          trusted: quotaTrusted(session),
          prepared,
          signal: generationController.signal,
          onEvent: send,
        });
      } catch (err) {
        console.error("[dashboard.api.store.generate] runtime-1 build failed", err);
        send({ stage: "error", ...buildFailure(err) });
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abortFromRequest);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      // buildStorefrontDesign may hang on a non-abort-aware await; don't leave
      // the interval (and the start() closure) alive behind a no-op write.
      clearInterval(heartbeat);
      generationController.abort(new DOMException("Storefront generation stopped", "AbortError"));
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
