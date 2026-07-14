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

  it("sends bounded image bytes as opaque Anthropic image blocks without storage URLs", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "tool-1", name: "storefront_compiler_result", input: { ok: true } }],
      usage: {},
    });
    const provider = createAnthropicStructuredProvider({ client: { messages: { create } }, model: "test-model" });
    await provider.complete({
      operation: "concept",
      system: "system",
      prompt: "prompt",
      schema: { type: "object" },
      images: [{ key: "reference-image-001", mediaType: "image/webp", bytes: new Uint8Array([1, 2, 3]) }],
    });

    const serialized = JSON.stringify(create.mock.calls[0][0]);
    expect(serialized).toContain("reference-image-001");
    expect(serialized).toContain(Buffer.from([1, 2, 3]).toString("base64"));
    expect(serialized).not.toMatch(/https?:|storage\//i);
  });

  it("rejects oversized image evidence before calling the provider", async () => {
    const create = vi.fn();
    const provider = createAnthropicStructuredProvider({ client: { messages: { create } }, model: "test-model" });
    await expect(provider.complete({
      operation: "concept",
      system: "system",
      prompt: "prompt",
      schema: { type: "object" },
      images: [{ key: "reference-image-001", mediaType: "image/webp", bytes: new Uint8Array(5 * 1024 * 1024 + 1) }],
    })).rejects.toThrow(/image evidence/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects AVIF evidence that the owned-byte verifier cannot sniff", async () => {
    const create = vi.fn();
    const provider = createAnthropicStructuredProvider({ client: { messages: { create } }, model: "test-model" });
    await expect(provider.complete({
      operation: "concept",
      system: "system",
      prompt: "prompt",
      schema: { type: "object" },
      images: [{ key: "reference-image-001", mediaType: "image/avif", bytes: new Uint8Array([1]) }],
    } as never)).rejects.toThrow(/image evidence/i);
    expect(create).not.toHaveBeenCalled();
  });
});
