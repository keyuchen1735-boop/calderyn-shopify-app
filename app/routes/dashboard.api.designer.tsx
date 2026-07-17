// app/routes/dashboard.api.designer.tsx
// Chat endpoint for the from-scratch designer engine (hidden Labs). One POST
// per merchant message. Edit turns answer as plain JSON; the FIRST build
// (no documents yet) streams NDJSON so every finished page reaches the
// merchant the moment it is saved instead of after one long wait.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { quotaTrusted } from "~/lib/ai-quota.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import {
  designerFirstBuild,
  designerHasDocuments,
  designerTurn,
  type DesignerBuildMode,
} from "~/lib/designer/engine.server";
import type { DesignerRoute } from "~/lib/designer/types";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";

export const config = { maxDuration: 800 };

const MESSAGE_MAX = 4_000;
const ROUTES = new Set(["home", "collection", "product", "search", "cart", "checkout"]);

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
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MESSAGE_MAX) {
    return jsonError(422, "invalid_message", "Describe the change in up to 4,000 characters.");
  }
  if (body.model !== undefined && body.model !== "sonnet" && body.model !== "opus") {
    return jsonError(422, "invalid_model", "Model must be sonnet or opus.");
  }
  if (body.page !== undefined && (typeof body.page !== "string" || !ROUTES.has(body.page))) {
    return jsonError(422, "invalid_page");
  }
  if (body.mode !== undefined && body.mode !== "template" && body.mode !== "scratch") {
    return jsonError(422, "invalid_mode", "Mode must be template or scratch.");
  }

  const settings = await getStoreSettings(session.shopId);
  if (!settings.composerEnabled) {
    return jsonError(409, "designer_disabled", "The designer engine is not enabled for this store.");
  }
  if (!(await rateLimit(`designer-chat:${session.shopId}`, 20, 60_000))) {
    return jsonError(429, "rate_limited", "Too many designer messages. Please wait a moment.");
  }

  let hasDocuments: boolean;
  try {
    hasDocuments = await designerHasDocuments(session.shopId);
  } catch (err) {
    console.error("[dashboard.api.designer] documents lookup failed", err);
    return jsonError(503, "designer_unavailable", "The designer is briefly unavailable. Try again in a moment.");
  }
  if (hasDocuments) {
    return dashboardJson(async () => {
      await assertCanGenerate(session.shopId, message, { trusted: quotaTrusted(session) });
      return designerTurn({
        shopId: session.shopId,
        message,
        route: body.page as DesignerRoute | undefined,
        model: body.model as StudioDesignModel | undefined,
        signal: request.signal,
      });
    });
  }

  // One first build at a time per shop: two racing builds would double the
  // model spend and interleave their page saves. The window only needs to
  // outlast a click race; a failed build can retry two minutes later.
  if (!(await rateLimit(`designer-build:${session.shopId}`, 1, 120_000))) {
    return jsonError(409, "build_running", "A store build is already running. Give it a couple of minutes.");
  }

  // First build: stream page events. The quota guard still runs first — its
  // refusal must arrive as a plain JSON error, not a broken stream.
  try {
    await assertCanGenerate(session.shopId, message, { trusted: quotaTrusted(session) });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status < 500) {
      return jsonError(status, (err as { code?: string }).code ?? "generation_blocked", (err as Error).message);
    }
    throw err;
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const buildController = new AbortController();
  const abortFromRequest = () => buildController.abort(new DOMException("Client left", "AbortError"));
  request.signal.addEventListener("abort", abortFromRequest);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: Record<string, unknown>) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      // Keep intermediaries and client watchdogs fed between model calls.
      heartbeat = setInterval(() => {
        try { write({ kind: "heartbeat" }); } catch { clearInterval(heartbeat); }
      }, 15_000);
      try {
        const done = await designerFirstBuild({
          shopId: session.shopId,
          message,
          mode: body.mode as DesignerBuildMode | undefined,
          model: body.model as StudioDesignModel | undefined,
          signal: buildController.signal,
          onEvent: (event) => write({ ...event }),
        });
        write({ kind: "done", ...done });
      } catch (err) {
        console.error("[dashboard.api.designer] first build failed", err);
        write({ kind: "error", message: "The build hit a problem partway. Finished pages are saved; send another message to continue." });
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abortFromRequest);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      clearInterval(heartbeat);
      buildController.abort(new DOMException("Designer build stopped", "AbortError"));
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
