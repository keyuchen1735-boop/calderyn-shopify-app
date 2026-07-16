import { apiGet, DashboardApiError } from "./client";
import type { StudioState } from "~/lib/storebuilder/studio-types";
import type { StoreCommand, StoreCommandEvent, StoreCommandReceipt } from "~/lib/storefront-command/types";

export type { StudioState };

export async function fetchStore(): Promise<StudioState> {
  return apiGet<StudioState>("/dashboard/api/store");
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Stopped", "AbortError");
}

function receipt(value: unknown): StoreCommandReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === "unchanged" && typeof candidate.message === "string") {
    return { status: "unchanged", message: candidate.message };
  }
  if (candidate.status === "published" && typeof candidate.versionId === "string") {
    return { status: "published", versionId: candidate.versionId };
  }
  if (candidate.status !== "installed" || typeof candidate.versionId !== "string") return null;
  if (candidate.undo === null) {
    return { status: "installed", versionId: candidate.versionId, undo: null };
  }
  if (!candidate.undo || typeof candidate.undo !== "object" || Array.isArray(candidate.undo)) return null;
  const undo = candidate.undo as Record<string, unknown>;
  if (typeof undo.targetVersionId !== "string" || typeof undo.expectedDraftVersionId !== "string") return null;
  return {
    status: "installed",
    versionId: candidate.versionId,
    undo: { targetVersionId: undo.targetVersionId, expectedDraftVersionId: undo.expectedDraftVersionId },
  };
}

function event(line: string): StoreCommandEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new DashboardApiError(502, "storefront_command_stream_invalid", "The storefront response was invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DashboardApiError(502, "storefront_command_stream_invalid", "The storefront response was invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (["understanding", "preparing_products", "checking_preview"].includes(String(candidate.stage))) {
    return { stage: candidate.stage as "understanding" | "preparing_products" | "checking_preview" };
  }
  if (candidate.stage === "ready") {
    const parsedReceipt = receipt(candidate.receipt);
    if (parsedReceipt) return { stage: "ready", receipt: parsedReceipt };
  }
  if (
    candidate.stage === "error"
    && typeof candidate.code === "string"
    && typeof candidate.status === "number"
    && typeof candidate.message === "string"
  ) {
    return {
      stage: "error",
      code: candidate.code,
      status: candidate.status,
      message: candidate.message,
    };
  }
  throw new DashboardApiError(502, "storefront_command_stream_invalid", "The storefront response was invalid.");
}

async function httpError(response: Response): Promise<DashboardApiError> {
  let body: { error?: unknown; message?: unknown } = {};
  try {
    body = await response.json() as typeof body;
  } catch {
    // Stable fallback below.
  }
  return new DashboardApiError(
    response.status,
    typeof body.error === "string" ? body.error : `http_${response.status}`,
    typeof body.message === "string" ? body.message : "The storefront request failed.",
  );
}

export async function sendStoreCommand(
  command: StoreCommand,
  onEvent: (event: StoreCommandEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<StoreCommandReceipt> {
  let response: Response;
  try {
    response = await fetch("/dashboard/api/store", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(typeof location !== "undefined" ? { Origin: location.origin } : {}),
      },
      body: JSON.stringify(command),
      signal,
    });
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    throw new DashboardApiError(0, "storefront_command_network_error", "Could not reach the storefront service.");
  }
  if (!response.ok) throw await httpError(response);
  if (!response.body) {
    throw new DashboardApiError(502, "storefront_command_stream_incomplete", "The storefront response ended early.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = async (line: string): Promise<StoreCommandReceipt | null> => {
    const parsed = event(line);
    await onEvent(parsed);
    if (parsed.stage === "error") {
      throw new DashboardApiError(parsed.status, parsed.code, parsed.message);
    }
    return parsed.stage === "ready" ? parsed.receipt : null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const terminal = await handle(line);
          if (terminal) {
            await reader.cancel();
            return terminal;
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const terminal = await handle(buffer.trim());
      if (terminal) return terminal;
    }
  } catch (error) {
    if (error instanceof DashboardApiError) throw error;
    if (signal?.aborted) throw abortReason(signal);
    throw new DashboardApiError(502, "storefront_command_stream_invalid", "The storefront response was invalid.");
  }
  throw new DashboardApiError(502, "storefront_command_stream_incomplete", "The storefront response ended early.");
}
