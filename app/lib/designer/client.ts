// Designer-owned dashboard client: everything the sparkle studio needs from
// the browser, kept out of the classic builder's store-client on purpose so
// the two surfaces can evolve (and merge) independently.
import { DashboardApiError } from "~/lib/dashboard/client";
import { throwIfVersionSkew } from "~/lib/dashboard/version-skew";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import type { DesignerChange } from "~/lib/designer/types";

/** Session lapsed: recover the way every dashboard call does. */
function redirectToLogin(): void {
  if (typeof window !== "undefined") window.location.assign("/login");
}

export interface DesignerStateVM {
  enabled: boolean;
  ready: boolean;
  unbuiltRoutes: string[];
  chat: Array<{ role: "user" | "assistant"; body: string }>;
}

async function designerRequest<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/dashboard/api/designer", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) redirectToLogin();
  throwIfVersionSkew(res);
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok || !data) {
    throw new DashboardApiError(res.status, data?.error ?? "designer_failed", data?.message ?? "The designer couldn't process that.");
  }
  return data;
}

export function fetchDesignerState(): Promise<DesignerStateVM> {
  return fetch("/dashboard/api/designer", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((res) => {
      if (res.status === 401) redirectToLogin();
      if (!res.ok) throw new DashboardApiError(res.status, "designer_state_failed", "Couldn't load the designer.");
      return res.json() as Promise<DesignerStateVM>;
    });
}

export function setDesignerEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  return designerRequest({ action: "set-enabled", enabled });
}

export function publishDesignerSite(): Promise<{ storefrontUrl: string }> {
  return designerRequest({ action: "publish" });
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
  /** Per-surface summary of what changed this turn (edit turns only). */
  changes: DesignerChange[];
}

/** One conversational turn against the designer engine. Edit turns answer as
 *  JSON; first builds (and resumes) stream NDJSON page events — each finished
 *  page fires onPage, and the final done event resolves the promise. */
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
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
    return {
      reply: data.reply,
      changed: data.changed === true,
      rejectedEdits: data.rejectedEdits ?? 0,
      changes: Array.isArray(data.changes) ? data.changes : [],
    };
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
      done = {
        reply: event.reply,
        changed: event.changed === true,
        rejectedEdits: Number(event.rejectedEdits ?? 0),
        // First builds narrate page by page and send no summary today, but a
        // resumed build's done event may carry one — don't discard it.
        changes: Array.isArray(event.changes) ? (event.changes as DesignerChange[]) : [],
      };
    } else if (event.kind === "error") {
      throw new DashboardApiError(502, "designer_build_failed", typeof event.message === "string" ? event.message : "The build failed partway.");
    }
  };
  // The server heartbeats every 15s between model calls. If the function is
  // killed with the connection left open (platform hard-stop), reader.read()
  // would otherwise pend forever and lock the composer for good.
  const STALL_MS = 50_000;
  try {
    for (;;) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => reject(new DOMException("Stream stalled", "TimeoutError")), STALL_MS);
      });
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await Promise.race([reader.read(), stalled]);
      } finally {
        clearTimeout(stallTimer);
      }
      const { done: finished, value } = step;
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
    if (err instanceof DashboardApiError) throw err;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    throw new DashboardApiError(502, "designer_stream_failed", "The build lost its connection. Finished pages are saved; send another message and I'll pick up where it left off.");
  } finally {
    reader.cancel().catch(() => {});
  }
  if (!done) throw new DashboardApiError(502, "designer_stream_failed", "The build stream ended early. Finished pages are saved; send another message and I'll pick up where it left off.");
  return done;
}
