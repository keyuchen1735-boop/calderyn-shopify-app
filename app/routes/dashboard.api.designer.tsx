// app/routes/dashboard.api.designer.tsx
// Chat endpoint for the from-scratch designer engine (hidden Labs). One POST
// per merchant message. Edit turns answer as plain JSON; the FIRST build
// (no documents yet) streams NDJSON so every finished page reaches the
// merchant the moment it is saved instead of after one long wait.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, releaseRateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { quotaTrusted } from "~/lib/ai-quota.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import {
  designerBuildState,
  designerFirstBuild,
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

  let buildState: Awaited<ReturnType<typeof designerBuildState>>;
  try {
    buildState = await designerBuildState(session.shopId);
  } catch (err) {
    console.error("[dashboard.api.designer] documents lookup failed", err);
    return jsonError(503, "designer_unavailable", "The designer is briefly unavailable. Try again in a moment.");
  }
  // A complete document set means a plain edit turn. Draft edits never touch
  // the live site, so a running experiment doesn't block them — the designer
  // publish path has its own experiment gate.
  if (buildState.hasDocuments && buildState.unbuiltRoutes.length === 0) {
    return dashboardJson(async () => {
      await assertCanGenerate(session.shopId, message, { trusted: quotaTrusted(session), skipExperimentCheck: true });
      return designerTurn({
        shopId: session.shopId,
        message,
        route: body.page as DesignerRoute | undefined,
        model: body.model as StudioDesignModel | undefined,
        signal: request.signal,
      });
    });
  }

  // First build (or a resume of an interrupted one): stream page events.
  // The quota guard runs BEFORE the build lock — a quota refusal must arrive
  // as a plain JSON error without consuming the lock and blocking the retry.
  try {
    await assertCanGenerate(session.shopId, message, { trusted: quotaTrusted(session), skipExperimentCheck: true });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status < 500) {
      return jsonError(status, (err as { code?: string }).code ?? "generation_blocked", (err as Error).message);
    }
    throw err;
  }

  // One build at a time per shop: two racing builds would double the model
  // spend and interleave their page saves. The window covers the gap until the
  // first page save flips routing to edit turns; the lock is released the
  // moment the stream ends (success or failure), so a failed build can retry
  // immediately instead of waiting the window out.
  const buildLockKey = `designer-build:${session.shopId}`;
  if (!(await rateLimit(buildLockKey, 1, 300_000))) {
    return jsonError(409, "build_running", "A store build is already running. Give it a couple of minutes.");
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
        write({ kind: "error", message: "The build hit a problem partway. Finished pages are saved; send another message and I'll pick up where it left off." });
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener("abort", abortFromRequest);
        await releaseRateLimit(buildLockKey);
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
