import { describe, expect, it, vi } from "vitest";
import { createAnthropicStructuredProvider, StructuredOutputError } from "./provider.server";

describe("createAnthropicStructuredProvider", () => {
  it("forces the schema tool and accepts tool input only", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "tool-1", name: "storefront_compiler_result", input: { ok: true } }],
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const provider = createAnthropicStructuredProvider({
      client: { messages: { create } },
      model: "test-model",
    });

    const response = await provider.complete({
      operation: "concept",
      system: "system",
      prompt: "prompt",
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    });

    expect(response.value).toEqual({ ok: true });
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({
      model: "test-model",
      tool_choice: { type: "tool", name: "storefront_compiler_result", disable_parallel_tool_use: true },
      tools: [expect.objectContaining({ name: "storefront_compiler_result" })],
    }));
  });

  it("rejects text or a mismatched tool instead of parsing model prose", async () => {
    const provider = createAnthropicStructuredProvider({
      client: { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{\"ok\":true}" }], usage: {} }) } },
      model: "test-model",
    });
    await expect(provider.complete({ operation: "concept", system: "s", prompt: "p", schema: { type: "object" } }))
      .rejects.toBeInstanceOf(StructuredOutputError);
  });
});
