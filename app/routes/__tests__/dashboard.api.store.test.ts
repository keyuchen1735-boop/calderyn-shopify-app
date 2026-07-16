import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import type { StoreCommand, StoreCommandEvent, StoreCommandReceipt } from "~/lib/storefront-command/types";
import { action, config, loader } from "../dashboard.api.store";
import { StoreCommandError } from "~/lib/storefront-command/command.server";

const { loadStateMock, originMock, rateLimitMock, runCommandMock, sessionMock } = vi.hoisted(() => ({
  loadStateMock: vi.fn(),
  originMock: vi.fn(),
  rateLimitMock: vi.fn(),
  runCommandMock: vi.fn(),
  sessionMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/http.server", async (original) => {
  const actual = await original<typeof HttpServer>();
  return { ...actual, rateLimit: rateLimitMock, requireSameOrigin: originMock };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storebuilder/studio.server", () => ({
  loadStudioState: loadStateMock,
}));
vi.mock("~/lib/storefront-command/command.server", () => ({
  runStoreCommand: runCommandMock,
  StoreCommandError: class StoreCommandError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  },
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const VERSION = "33333333-3333-3333-3333-333333333333";
const TARGET = "44444444-4444-4444-4444-444444444444";
const URL = "https://dashboard.example/dashboard/api/store";

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://dashboard.example" },
    body: JSON.stringify(body),
    ...init,
  });
}

async function streamEvents(response: Response): Promise<StoreCommandEvent[]> {
  return (await response.text())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoreCommandEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ shopId: SHOP, userId: USER });
  loadStateMock.mockResolvedValue({ hasDraft: false });
  rateLimitMock.mockResolvedValue(true);
  runCommandMock.mockImplementation(async (input: {
    command: StoreCommand;
    onEvent?: (event: StoreCommandEvent) => void | Promise<void>;
  }): Promise<StoreCommandReceipt> => {
    await input.onEvent?.({ stage: "understanding" });
    const receipt = input.command.kind === "publish"
      ? { status: "published" as const, versionId: VERSION }
      : { status: "installed" as const, versionId: VERSION, undo: null };
    await input.onEvent?.({ stage: "ready", receipt });
    return receipt;
  });
});

describe("dashboard.api.store command stream", () => {
  it("keeps the authenticated loader snapshot", async () => {
    const response = await loader({ request: new Request(URL) } as LoaderFunctionArgs);
    expect(response.status).toBe(200);
    expect(loadStateMock).toHaveBeenCalledWith(SHOP);
    expect(await response.json()).toEqual({ hasDraft: false });
  });

  it("runs a parsed prompt for the session shop and emits one terminal frame", async () => {
    const command: StoreCommand = { kind: "prompt", prompt: "make it warmer", expectedDraftVersionId: null };
    const req = request(command);

    const response = await action({ request: req } as ActionFunctionArgs);

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(runCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP,
      actorId: USER,
      command,
      signal: expect.any(AbortSignal),
    }));
    const events = await streamEvents(response);
    expect(events.map(({ stage }) => stage)).toEqual(["understanding", "ready"]);
    expect(events.filter(({ stage }) => stage === "ready" || stage === "error")).toHaveLength(1);
  });

  it.each<StoreCommand>([
    { kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: VERSION },
    { kind: "publish", expectedDraftVersionId: VERSION },
  ])("passes $kind session commands without changing their CAS pointers", async (command) => {
    const response = await action({ request: request(command) } as ActionFunctionArgs);
    await response.text();
    expect(runCommandMock).toHaveBeenCalledWith(expect.objectContaining({ command, shopId: SHOP, actorId: USER }));
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  it("rate limits prompt commands before opening the stream", async () => {
    rateLimitMock.mockResolvedValue(false);
    const response = await action({
      request: request({ kind: "prompt", prompt: "change it", expectedDraftVersionId: null }),
    } as ActionFunctionArgs);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
    expect(rateLimitMock).toHaveBeenCalledWith(`storefront-build:${SHOP}`, 10, 60_000);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    { action: "edit", prompt: "legacy" },
    { action: "publish" },
    { designRequest: { prompt: "legacy", mode: "auto" } },
    { kind: "prompt", prompt: "legacy model", expectedDraftVersionId: null, model: "opus" },
  ])("rejects a legacy body before command work", async (body) => {
    const response = await action({ request: request(body) } as ActionFunctionArgs);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_store_command" });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("rejects multipart before command work", async () => {
    const response = await action({
      request: new Request(URL, { method: "POST", body: new FormData() }),
    } as ActionFunctionArgs);
    expect(response.status).toBe(422);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it("does not duplicate the command runner's terminal error", async () => {
    runCommandMock.mockImplementationOnce(async (input: {
      onEvent?: (event: StoreCommandEvent) => void | Promise<void>;
    }) => {
      await input.onEvent?.({ stage: "error", code: "storefront_command_failed", status: 500, message: "The change failed." });
      throw new StoreCommandError("storefront_command_failed", "The change failed.", 500);
    });

    const response = await action({
      request: request({ kind: "prompt", prompt: "change it", expectedDraftVersionId: null }),
    } as ActionFunctionArgs);
    const events = await streamEvents(response);
    expect(events).toEqual([{ stage: "error", code: "storefront_command_failed", status: 500, message: "The change failed." }]);
  });

  it("aborts command work when the stream reader cancels", async () => {
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    runCommandMock.mockImplementationOnce((input: { signal?: AbortSignal }) => new Promise((resolve) => {
      signal = input.signal;
      finish = () => resolve({ status: "unchanged", message: "Stopped" });
    }));
    const response = await action({
      request: request({ kind: "prompt", prompt: "change it", expectedDraftVersionId: null }),
    } as ActionFunctionArgs);

    const cancelled = response.body!.getReader().cancel();
    expect(signal?.aborted).toBe(true);
    finish();
    await cancelled;
  });

  it("checks origin and session before running work and keeps the long route budget", async () => {
    const response = await action({
      request: request({ kind: "prompt", prompt: "change it", expectedDraftVersionId: null }),
    } as ActionFunctionArgs);
    await response.text();
    expect(originMock).toHaveBeenCalledOnce();
    expect(sessionMock).toHaveBeenCalledOnce();
    expect(config).toEqual({ maxDuration: 800 });
  });
});
