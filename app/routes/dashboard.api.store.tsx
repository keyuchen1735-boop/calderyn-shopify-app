import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { loadStudioState } from "~/lib/storebuilder/studio.server";
import { runStoreCommand, StoreCommandError } from "~/lib/storefront-command/command.server";
import { parseStoreCommand, type StoreCommandEvent } from "~/lib/storefront-command/types";

export const config = { maxDuration: 800 };

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadStudioState(session.shopId));
}

function commandStream(
  requestSignal: AbortSignal,
  run: (onEvent: (event: StoreCommandEvent) => void, signal: AbortSignal) => Promise<unknown>,
): Response {
  const encoder = new TextEncoder();
  const commandController = new AbortController();
  let cancelled = false;
  let terminal = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abortFromRequest = () => commandController.abort(requestSignal.reason);
  if (requestSignal.aborted) commandController.abort(requestSignal.reason);
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StoreCommandEvent) => {
        if (cancelled || terminal) return;
        if (event.stage === "ready" || event.stage === "error") terminal = true;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      heartbeat = setInterval(() => {
        if (!cancelled && !terminal) controller.enqueue(encoder.encode("\n"));
      }, 15_000);
      try {
        await run(send, commandController.signal);
      } catch (error) {
        if (!(error instanceof StoreCommandError) && !terminal && !cancelled) {
          console.error("[dashboard.api.store] command stream failed", error);
          send({
            stage: "error",
            code: "storefront_command_failed",
            status: 500,
            message: "The storefront change could not be completed. Your current draft was not changed.",
          });
        }
      } finally {
        clearInterval(heartbeat);
        requestSignal.removeEventListener("abort", abortFromRequest);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      clearInterval(heartbeat);
      commandController.abort(new DOMException("Storefront command stopped", "AbortError"));
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return jsonError(422, "invalid_store_command");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, "invalid_store_command");
  }
  const parsed = parseStoreCommand(body);
  if (!parsed.ok) return jsonError(422, parsed.code);
  if (parsed.value.kind === "prompt"
    && !(await rateLimit(`storefront-build:${session.shopId}`, 10, 60_000))) {
    return jsonError(429, "rate_limited", "Too many storefront changes. Please wait a moment.");
  }

  return commandStream(request.signal, (onEvent, signal) => runStoreCommand({
    shopId: session.shopId,
    actorId: session.userId ?? null,
    command: parsed.value,
    onEvent,
    signal,
  }));
}
