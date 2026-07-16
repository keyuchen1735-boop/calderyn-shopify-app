import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardApiError } from "./client";
import { fetchStore, sendStoreCommand } from "./store-client";
import type { StoreCommand, StoreCommandEvent } from "~/lib/storefront-command/types";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("./client", () => ({
  apiGet,
  DashboardApiError: class DashboardApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
      this.name = "DashboardApiError";
    }
  },
}));

const VERSION = "33333333-3333-3333-3333-333333333333";
const TARGET = "44444444-4444-4444-4444-444444444444";

function responseFromChunks(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status, headers: { "content-type": "application/x-ndjson" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchStore", () => {
  it("reads the sole Store endpoint", async () => {
    apiGet.mockResolvedValueOnce({ hasDraft: true });
    await expect(fetchStore()).resolves.toEqual({ hasDraft: true });
    expect(apiGet).toHaveBeenCalledWith("/dashboard/api/store");
  });
});

describe("sendStoreCommand", () => {
  const commands: StoreCommand[] = [
    { kind: "prompt", prompt: "make it warmer", expectedDraftVersionId: VERSION },
    { kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: VERSION },
    { kind: "publish", expectedDraftVersionId: VERSION },
  ];

  it.each(commands)("sends $kind to the sole Store endpoint", async (command) => {
    vi.stubGlobal("location", { origin: "https://dashboard.example" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromChunks([
      '{"stage":"ready","receipt":{"status":"unchanged","message":"No change"}}\n',
    ])));
    const controller = new AbortController();

    await sendStoreCommand(command, () => undefined, controller.signal);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/dashboard/api/store", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Origin: "https://dashboard.example" },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
  });

  it("parses fragmented, batched, blank, and trailing NDJSON lines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromChunks([
      '{"stage":"under',
      'standing"}\n\n{"stage":"preparing_products"}\n{"stage":"checking_preview"}\n{"stage":"rea',
      'dy","receipt":{"status":"installed","versionId":"33333333-3333-3333-3333-333333333333","undo":null}}',
    ])));
    const events: StoreCommandEvent[] = [];

    const receipt = await sendStoreCommand(
      { kind: "prompt", prompt: "build", expectedDraftVersionId: null },
      (event) => { events.push(event); },
    );

    expect(events.map(({ stage }) => stage)).toEqual(["understanding", "preparing_products", "checking_preview", "ready"]);
    expect(receipt).toEqual({ status: "installed", versionId: VERSION, undo: null });
  });

  it("maps an HTTP refusal to DashboardApiError without a fallback request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "invalid_store_command", message: "Invalid command." }),
      { status: 422, headers: { "content-type": "application/json" } },
    )));
    await expect(sendStoreCommand(
      { kind: "prompt", prompt: "build", expectedDraftVersionId: null },
      () => undefined,
    )).rejects.toMatchObject({ status: 422, code: "invalid_store_command" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps an in-band error to DashboardApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromChunks([
      '{"stage":"error","code":"storefront_command_conflict","status":409,"message":"Refresh and try again."}\n',
    ])));
    await expect(sendStoreCommand(
      { kind: "prompt", prompt: "build", expectedDraftVersionId: null },
      () => undefined,
    )).rejects.toMatchObject({ status: 409, code: "storefront_command_conflict" });
  });

  it("preserves abort errors", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
    })));
    const pending = sendStoreCommand(
      { kind: "prompt", prompt: "build", expectedDraftVersionId: null },
      () => undefined,
      controller.signal,
    );
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("maps network and missing-terminal failures to DashboardApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")));
    await expect(sendStoreCommand(
      { kind: "prompt", prompt: "build", expectedDraftVersionId: null },
      () => undefined,
    )).rejects.toBeInstanceOf(DashboardApiError);

    vi.mocked(fetch).mockResolvedValueOnce(responseFromChunks(['{"stage":"understanding"}\n']));
    await expect(sendStoreCommand(
      { kind: "prompt", prompt: "build", expectedDraftVersionId: null },
      () => undefined,
    )).rejects.toMatchObject({ code: "storefront_command_stream_incomplete" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
