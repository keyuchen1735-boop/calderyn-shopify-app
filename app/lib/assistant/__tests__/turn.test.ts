import { describe, it, expect, vi, beforeEach } from "vitest";
import { runConversationTurn } from "../turn.server";
import * as toolsModule from "../tools.server";
import * as loopModule from "../loop.server";
import * as conversationsModule from "../conversations.server";

vi.mock("../../calderyn.server", () => ({
  calderynClient: vi.fn(() => ({})),
}));

vi.mock("../anthropic.server", () => ({
  getAnthropic: vi.fn(() => ({ messages: { create: vi.fn() } })),
  assistantModel: vi.fn(() => "test-model"),
}));

vi.mock("../snapshot.server", () => ({
  buildSnapshot: vi.fn(async () => "snapshot"),
}));

vi.mock("../prompt.server", () => ({
  buildSystemPrompt: vi.fn(() => "system"),
}));

vi.mock("../tools.server", () => ({
  ASSISTANT_TOOLS: [{ name: "list_alerts" }, { name: "pause_campaign" }],
  READ_TOOLS: [{ name: "list_alerts" }],
  makeToolDispatcher: vi.fn(() => vi.fn()),
}));

vi.mock("../loop.server", () => ({
  runAssistantTurn: vi.fn(async () => ({
    text: "hi",
    draftedAction: null,
    receipts: [],
    pendingAction: null,
  })),
}));

vi.mock("../conversations.server", () => ({
  createConversation: vi.fn(async () => "conv-1"),
  getMessages: vi.fn(async () => []),
  appendMessage: vi.fn(async (shopDomain, conversationId, input) => ({
    id: "msg-1",
    role: input.role,
    content: input.content,
    draftedAction: input.draftedAction ?? null,
    receipts: input.receipts ?? [],
    pendingAction: input.pendingAction ?? null,
    createdAt: "now",
  })),
}));

describe("runConversationTurn allowActions gating", () => {
  beforeEach(() => {
    vi.mocked(toolsModule.makeToolDispatcher).mockClear();
    vi.mocked(loopModule.runAssistantTurn).mockClear();
    vi.mocked(conversationsModule.createConversation).mockClear();
  });

  it("without allowActions: no actionCtx is built and only READ_TOOLS are advertised (legacy embedded surface default)", async () => {
    await runConversationTurn({
      shopDomain: "my-shop.myshopify.com",
      message: "pause campaign x",
      conversationId: null,
    });

    expect(vi.mocked(toolsModule.makeToolDispatcher)).toHaveBeenCalledTimes(1);
    const depsArg = vi.mocked(toolsModule.makeToolDispatcher).mock.calls[0][1];
    expect(depsArg?.actionCtx).toBeUndefined();

    const loopArg = vi.mocked(loopModule.runAssistantTurn).mock.calls[0][0];
    expect(loopArg.tools).toEqual(toolsModule.READ_TOOLS);
    expect(loopArg.tools.map((t: { name: string }) => t.name)).not.toContain("pause_campaign");
  });

  it("with allowActions: true: actionCtx is present and the full write-tool set is advertised (dashboard behavior unchanged)", async () => {
    await runConversationTurn({
      shopDomain: "shop-uuid-1",
      message: "pause campaign x",
      conversationId: "conv-existing",
      allowActions: true,
    });

    expect(vi.mocked(toolsModule.makeToolDispatcher)).toHaveBeenCalledTimes(1);
    const depsArg = vi.mocked(toolsModule.makeToolDispatcher).mock.calls[0][1];
    expect(depsArg?.actionCtx).toEqual({ shopId: "shop-uuid-1", conversationId: "conv-existing" });

    const loopArg = vi.mocked(loopModule.runAssistantTurn).mock.calls[0][0];
    expect(loopArg.tools).toEqual(toolsModule.ASSISTANT_TOOLS);
    expect(loopArg.tools.map((t: { name: string }) => t.name)).toContain("pause_campaign");
  });

  it("passes through caller deps (e.g. flagAlert) unchanged regardless of allowActions", async () => {
    const flagAlert = vi.fn(async () => true);
    await runConversationTurn({
      shopDomain: "my-shop.myshopify.com",
      message: "flag it",
      conversationId: null,
      deps: { flagAlert },
    });

    const depsArg = vi.mocked(toolsModule.makeToolDispatcher).mock.calls[0][1];
    expect(depsArg?.flagAlert).toBe(flagAlert);
    expect(depsArg?.actionCtx).toBeUndefined();
  });
});
