// app/lib/storegen/attachment-intent.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
// vi.mock is hoisted above this import by vitest, so the mock is in place before
// the module under test is evaluated (same ordering as the other route/lib tests).
import { classifyAttachmentIntent } from "./attachment-intent.server";

// getAnthropic is a controllable mock so the API-error test can swap in a client
// whose `create` is a PLAIN rejecting function. (A rejection thrown *by a vi.fn
// spy* is flagged by Vitest as an unhandled test error even when the code catches
// it — a plain function's rejection is not, so this keeps `createMock` a spy for
// the call-shape assertions while still exercising the real catch branch.)
const { createMock, getAnthropicMock } = vi.hoisted(() => ({ createMock: vi.fn(), getAnthropicMock: vi.fn() }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: getAnthropicMock,
  digestModel: () => "claude-haiku-4-5",
}));

const reply = (text: string) => ({ content: [{ type: "text", text }] });
const img = { mediaType: "image/png", dataBase64: "aGVsbG8=" };

beforeEach(() => {
  createMock.mockReset();
  getAnthropicMock.mockReset();
  getAnthropicMock.mockReturnValue({ messages: { create: createMock } });
});

describe("classifyAttachmentIntent", () => {
  it("parses a clean JSON decision", async () => {
    createMock.mockResolvedValue(reply('{"addAsProducts":true,"useAsReference":false}'));
    const out = await classifyAttachmentIntent({ brief: "add these to my shop", images: [img] });
    expect(out).toEqual({ addAsProducts: true, useAsReference: false });
  });

  it("strips a ```json code fence before parsing", async () => {
    createMock.mockResolvedValue(reply('```json\n{"addAsProducts":false,"useAsReference":true}\n```'));
    const out = await classifyAttachmentIntent({ brief: null, images: [img] });
    expect(out).toEqual({ addAsProducts: false, useAsReference: true });
  });

  it("returns null on junk (non-JSON) output", async () => {
    createMock.mockResolvedValue(reply("I think you probably want to add them, maybe?"));
    expect(await classifyAttachmentIntent({ brief: null, images: [img] })).toBeNull();
  });

  it("returns null when the model call throws (API down / out of credits)", async () => {
    getAnthropicMock.mockReturnValue({
      messages: { create: () => Promise.reject(new Error("api down")) },
    });
    expect(await classifyAttachmentIntent({ brief: "x", images: [img] })).toBeNull();
  });

  it("returns null on a both-false decision — ask the merchant, never guess", async () => {
    createMock.mockResolvedValue(reply('{"addAsProducts":false,"useAsReference":false}'));
    expect(await classifyAttachmentIntent({ brief: null, images: [img] })).toBeNull();
  });

  it("returns null when a key is missing or not a boolean", async () => {
    createMock.mockResolvedValue(reply('{"addAsProducts":"yes"}'));
    expect(await classifyAttachmentIntent({ brief: null, images: [img] })).toBeNull();
  });

  it("does not spend a call when no attachment has a usable media type", async () => {
    const out = await classifyAttachmentIntent({
      brief: "hi",
      images: [{ mediaType: "image/tiff", dataBase64: "x" }],
    });
    expect(out).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sends the brief as untrusted text plus the image blocks", async () => {
    createMock.mockResolvedValue(reply('{"addAsProducts":true,"useAsReference":true}'));
    await classifyAttachmentIntent({ brief: "add these and match their vibe", images: [img] });
    const content = createMock.mock.calls[0][0].messages[0].content as Array<{ type: string; text?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("add these and match their vibe");
    expect(content[0].text?.toLowerCase()).toContain("untrusted");
    expect(content.some((b) => b.type === "image")).toBe(true);
  });
});
