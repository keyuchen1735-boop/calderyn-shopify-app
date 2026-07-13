import { describe, it, expect } from "vitest";
import { parseAssistantRequest, pickActiveConversation, RESUME_WINDOW_MS } from "../request.server";
import type { ConversationSummary } from "../types";

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

describe("pickActiveConversation", () => {
  const NOW = new Date("2026-07-09T12:00:00.000Z");

  function conv(id: string, updatedAt: string): ConversationSummary {
    return { id, title: null, updatedAt };
  }

  it("resumes a recent conversation (2h old)", () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const conversations = [conv("c1", twoHoursAgo)];
    expect(pickActiveConversation(conversations, null, NOW)).toBe("c1");
  });

  it("does not resume a stale conversation (10 days old)", () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const conversations = [conv("c1", tenDaysAgo)];
    expect(pickActiveConversation(conversations, null, NOW)).toBeNull();
  });

  it("always honors a requested id, even when the conversation is stale", () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const conversations = [conv("c1", tenDaysAgo)];
    expect(pickActiveConversation(conversations, "c1", NOW)).toBe("c1");
    // Even a requested id absent from the list still wins (deep links).
    expect(pickActiveConversation(conversations, "other-id", NOW)).toBe("other-id");
  });

  it("returns null for an empty conversation list with no requested id", () => {
    expect(pickActiveConversation([], null, NOW)).toBeNull();
  });

  it("pins the exactly-at-window boundary as still resumable", () => {
    const atBoundary = new Date(NOW.getTime() - RESUME_WINDOW_MS).toISOString();
    const conversations = [conv("c1", atBoundary)];
    expect(pickActiveConversation(conversations, null, NOW)).toBe("c1");
  });

  it("pins one millisecond past the window as stale", () => {
    const justPast = new Date(NOW.getTime() - RESUME_WINDOW_MS - 1).toISOString();
    const conversations = [conv("c1", justPast)];
    expect(pickActiveConversation(conversations, null, NOW)).toBeNull();
  });
});
