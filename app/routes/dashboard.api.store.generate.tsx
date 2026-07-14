// app/routes/dashboard.api.store.generate.tsx
// Streaming twin of /dashboard/api/store's "generate" action: same guards, same
// generation — but real build stages are streamed to the studio chat as NDJSON
// lines while the merchant waits, ending with the receipt (or an in-band error
// line; the HTTP status is already committed once the stream starts). Guard and
// validation failures reject as plain JSON BEFORE the stream opens, so quota and
// rate-limit errors keep their proper status codes.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { generateStore } from "~/lib/storegen/generate.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { CalderynError } from "~/lib/calderyn.server";
import { quotaTrusted } from "~/lib/ai-quota.server";
import type { StudioGenerateReceipt } from "~/lib/storebuilder/studio-types";
import { STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import { parseStoreDesignRequest } from "~/lib/storefront-bundle/routing";
import {
  buildStorefrontDesign,
  StorefrontBuildError,
  type StorefrontBuildEvent,
} from "~/lib/storefront-bundle/build.server";
import type { StoreDesignResolution } from "~/lib/storefront-bundle/types";

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

  if (Object.hasOwn(body, "designRequest")) {
    const parsed = parseStoreDesignRequest(body.designRequest, STORE_TEMPLATE_REGISTRY);
    if (!parsed.ok) return jsonError(422, parsed.error);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: StorefrontBuildEvent | { stage: "error"; message: string }) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          await buildStorefrontDesign({
            shopId: session.shopId,
            actorId: session.userId,
            request: parsed.value,
            recommendedResolution: recommendedResolution(body.recommendedResolution),
            onEvent: send,
          });
        } catch (err) {
          console.error("[dashboard.api.store.generate] runtime-1 build failed", err);
          send({
            stage: "error",
            message: err instanceof StorefrontBuildError
              ? err.message
              : "Storefront build failed. Your current draft was not changed.",
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const brief = typeof body.brief === "string" && body.brief.trim() ? body.brief.trim() : undefined;
  if (body.model !== undefined && body.model !== "sonnet" && body.model !== "opus") {
    return jsonError(422, "invalid_model", "Model must be sonnet or opus.");
  }
  const designModel = body.model as "sonnet" | "opus" | undefined;

  try {
    await assertCanGenerate(session.shopId, brief, { trusted: quotaTrusted(session) });
  } catch (err) {
    if (err instanceof CalderynError) return jsonError(err.status, err.code, err.message);
    throw err;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
      try {
        const result = await generateStore({
          shopId: session.shopId,
          mode: brief ? "brief" : "catalog",
          brief,
          designModel,
          onStage: (stage) => send({ stage }),
        });
        const receipt: StudioGenerateReceipt = {
          runId: result.runId,
          status: result.status,
          ...(result.verification ? { verification: result.verification } : {}),
          ...(result.referencesUnread ? { referencesUnread: true as const } : {}),
        };
        send({ stage: "done", receipt });
      } catch (err) {
        // The stream is already 200; surface the failure in-band with a stable
        // merchant-safe message — upstream detail goes to the server log only.
        console.error("[dashboard.api.store.generate] stream generation failed", err);
        send({ stage: "error", message: "Store generation failed. Please try again." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
