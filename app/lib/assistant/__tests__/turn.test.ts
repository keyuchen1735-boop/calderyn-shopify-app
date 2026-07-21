import { describe, it, expect, vi, beforeEach } from "vitest";
import { runConversationTurn } from "../turn.server";
import * as toolsModule from "../tools.server";
import * as loopModule from "../loop.server";
import * as conversationsModule from "../conversations.server";
import * as promptModule from "../prompt.server";
import * as orgModeModule from "../../cutover/org-mode.server";

vi.mock("../../calderyn.server", () => ({
  calderynClient: vi.fn(() => ({})),
}));

vi.mock("../../cutover/org-mode.server", () => ({
  shopHasShopifyConnection: vi.fn(async () => false),
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

describe("runConversationTurn platform grounding", () => {
  beforeEach(() => {
    vi.mocked(promptModule.buildSystemPrompt).mockClear();
    vi.mocked(orgModeModule.shopHasShopifyConnection).mockReset();
  });

  it("dashboard turn for a NATIVE shop (no Shopify connection) builds the prompt with platform=native", async () => {
    vi.mocked(orgModeModule.shopHasShopifyConnection).mockResolvedValue(false);

    await runConversationTurn({
      shopDomain: "shop-uuid-native",
      message: "How do I get paid when someone buys a candle?",
      conversationId: null,
      allowActions: true,
    });

    expect(vi.mocked(orgModeModule.shopHasShopifyConnection)).toHaveBeenCalledWith(
      "shop-uuid-native",
    );
    expect(vi.mocked(promptModule.buildSystemPrompt)).toHaveBeenCalledWith(
      "snapshot",
      "native",
    );
  });

  it("dashboard turn for a Shopify-connected shop builds the prompt with platform=shopify_connected", async () => {
    vi.mocked(orgModeModule.shopHasShopifyConnection).mockResolvedValue(true);

    await runConversationTurn({
      shopDomain: "shop-uuid-migrating",
      message: "Where is my imported catalog?",
      conversationId: null,
      allowActions: true,
    });

    expect(vi.mocked(promptModule.buildSystemPrompt)).toHaveBeenCalledWith(
      "snapshot",
      "shopify_connected",
    );
  });

  it("legacy embedded turn (no allowActions, shop DOMAIN) is shopify_connected without a lookup", async () => {
    await runConversationTurn({
      shopDomain: "my-shop.myshopify.com",
      message: "hello",
      conversationId: null,
    });

    // The shops lookup is keyed by id, not domain — it must never run here.
    expect(vi.mocked(orgModeModule.shopHasShopifyConnection)).not.toHaveBeenCalled();
    expect(vi.mocked(promptModule.buildSystemPrompt)).toHaveBeenCalledWith(
      "snapshot",
      "shopify_connected",
    );
  });

  it("a platform-lookup failure degrades to native grounding instead of failing the turn", async () => {
    vi.mocked(orgModeModule.shopHasShopifyConnection).mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runConversationTurn({
        shopDomain: "shop-uuid-native",
        message: "hi",
        conversationId: null,
        allowActions: true,
      });

      expect(result.assistantMessage.content).toBe("hi");
      expect(vi.mocked(promptModule.buildSystemPrompt)).toHaveBeenCalledWith(
        "snapshot",
        "native",
      );
      // The failure is surfaced in the log, never swallowed silently.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("platform lookup failed"),
        expect.objectContaining({ shop: "shop-uuid-native" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
