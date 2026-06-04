import { describe, it, expect } from "vitest";
import { parseAssistantRequest } from "../request.server";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseAssistantRequest", () => {
  it("accepts a valid message and trims it", () => {
    const r = parseAssistantRequest(fd({ message: "  why did profit drop?  " }));
    expect(r).toEqual({ ok: true, value: { conversationId: null, message: "why did profit drop?" } });
  });

  it("keeps a provided conversationId", () => {
    const r = parseAssistantRequest(fd({ message: "hi", conversationId: "c1" }));
    expect(r).toEqual({ ok: true, value: { conversationId: "c1", message: "hi" } });
  });

  it("rejects an empty message", () => {
    const r = parseAssistantRequest(fd({ message: "   " }));
    expect(r).toEqual({ ok: false, code: "MESSAGE_REQUIRED", message: expect.any(String) });
  });

  it("rejects an over-long message", () => {
    const r = parseAssistantRequest(fd({ message: "x".repeat(4001) }));
    expect(r).toMatchObject({ ok: false, code: "MESSAGE_TOO_LONG" });
  });
});
