import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const { runTurnSpy, appendSpy, createConvSpy, getMessagesSpy } = vi.hoisted(() => ({
  runTurnSpy: vi.fn(),
  appendSpy: vi.fn(),
  createConvSpy: vi.fn(),
  getMessagesSpy: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));
vi.mock("~/lib/calderyn.server", () => ({ calderynClient: () => ({}) }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: vi.fn() } }),
  assistantModel: () => "x",
}));
vi.mock("~/lib/assistant/snapshot.server", () => ({ buildSnapshot: async () => "snap" }));
vi.mock("~/lib/assistant/prompt.server", () => ({ buildSystemPrompt: () => [] }));
vi.mock("~/lib/assistant/tools.server", () => ({
  ASSISTANT_TOOLS: [],
  makeToolDispatcher: () => async () => ({ content: "{}" }),
}));
vi.mock("~/lib/assistant/loop.server", () => ({
  runAssistantTurn: (...a: unknown[]) => runTurnSpy(...a),
}));
vi.mock("~/lib/assistant/conversations.server", () => ({
  createConversation: (...a: unknown[]) => createConvSpy(...a),
  appendMessage: (...a: unknown[]) => appendSpy(...a),
  getMessages: (...a: unknown[]) => getMessagesSpy(...a),
  listConversations: async () => [],
}));

// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { action } from "../app.assistant";

function send(message: string, conversationId?: string): Promise<Response> {
  const fd = new FormData();
  fd.set("message", message);
  if (conversationId) fd.set("conversationId", conversationId);
  const request = new Request("http://localhost/app/assistant", { method: "POST", body: fd });
  return action({ request } as unknown as ActionFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  runTurnSpy.mockReset();
  appendSpy.mockReset();
  createConvSpy.mockReset();
  getMessagesSpy.mockReset();
  createConvSpy.mockResolvedValue("conv-1");
  getMessagesSpy.mockResolvedValue([]);
  appendSpy.mockImplementation(async (_s, _c, m) => ({
    id: "m1",
    role: m.role,
    content: m.content,
    draftedAction: m.draftedAction ?? null,
    createdAt: "2026-06-02T00:00:00Z",
  }));
  runTurnSpy.mockResolvedValue({ text: "here is the answer", draftedAction: null, stoppedAtCap: false });
});

describe("assistant action", () => {
  it("creates a conversation, persists both messages, returns the assistant reply", async () => {
    const res = await send("why did profit drop?");
    const body = (await res.json()) as { conversationId: string; assistantMessage: { content: string } };
    expect(createConvSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy.mock.calls[0][2]).toMatchObject({ role: "user", content: "why did profit drop?" });
    expect(appendSpy.mock.calls[1][2]).toMatchObject({ role: "assistant", content: "here is the answer" });
    expect(body.conversationId).toBe("conv-1");
    expect(body.assistantMessage.content).toBe("here is the answer");
  });

  it("rejects an empty message with 400 and runs no turn", async () => {
    const res = await send("   ");
    expect(res.status).toBe(400);
    expect(runTurnSpy).not.toHaveBeenCalled();
  });

  it("reuses an existing conversationId without creating a new one", async () => {
    await send("follow up", "conv-existing");
    expect(createConvSpy).not.toHaveBeenCalled();
    expect(appendSpy.mock.calls[0][1]).toBe("conv-existing");
  });
});
