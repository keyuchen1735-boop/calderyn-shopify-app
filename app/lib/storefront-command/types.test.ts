import { describe, expect, it } from "vitest";
import { parseStoreCommand } from "./types";

const VERSION = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

describe("parseStoreCommand", () => {
  it("accepts only prompt, undo, and publish", () => {
    expect(parseStoreCommand({ kind: "prompt", prompt: "make it calm", expectedDraftVersionId: null })).toEqual({
      ok: true,
      value: { kind: "prompt", prompt: "make it calm", expectedDraftVersionId: null },
    });
    expect(parseStoreCommand({ kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: VERSION }).ok).toBe(true);
    expect(parseStoreCommand({ kind: "publish", expectedDraftVersionId: VERSION }).ok).toBe(true);
    expect(parseStoreCommand({ kind: "generate", brief: "legacy" })).toEqual({ ok: false, code: "invalid_store_command" });
  });

  it("rejects markup and untyped attachments", () => {
    expect(parseStoreCommand({ kind: "prompt", prompt: "x", expectedDraftVersionId: null, html: "<main />" }).ok).toBe(false);
    expect(parseStoreCommand({ kind: "prompt", prompt: "x", expectedDraftVersionId: null, attachments: [{ url: "x" }] }).ok).toBe(false);
  });

  it("requires exact command, context, and attachment keys", () => {
    expect(parseStoreCommand({ kind: "publish", expectedDraftVersionId: VERSION, action: "legacy" }).ok).toBe(false);
    expect(parseStoreCommand({
      kind: "prompt",
      prompt: "Change this headline",
      expectedDraftVersionId: VERSION,
      context: { routeId: "home", slot: "heroTitle", regionId: "legacy-node" },
    }).ok).toBe(false);
    expect(parseStoreCommand({
      kind: "prompt",
      prompt: "Use this reference",
      expectedDraftVersionId: VERSION,
      attachments: [{ kind: "design_reference", assetRef: "store_asset/reference.png", url: "https://example.com" }],
    }).ok).toBe(false);
  });

  it("validates version UUIDs", () => {
    expect(parseStoreCommand({ kind: "prompt", prompt: "make it calm", expectedDraftVersionId: "draft-1" }).ok).toBe(false);
    expect(parseStoreCommand({ kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: "draft-1" }).ok).toBe(false);
    expect(parseStoreCommand({ kind: "publish", expectedDraftVersionId: "draft-1" }).ok).toBe(false);
  });

  it("caps prompts by Unicode code point", () => {
    expect(parseStoreCommand({ kind: "prompt", prompt: "🧶".repeat(4_000), expectedDraftVersionId: null }).ok).toBe(true);
    expect(parseStoreCommand({ kind: "prompt", prompt: "🧶".repeat(4_001), expectedDraftVersionId: null }).ok).toBe(false);
  });

  it("accepts only typed, bounded attachments and declared slot context", () => {
    expect(parseStoreCommand({
      kind: "prompt",
      prompt: "Use these",
      expectedDraftVersionId: VERSION,
      context: { routeId: "home", slot: "heroTitle" },
      attachments: [
        { kind: "design_reference", assetRef: "store_asset/reference.png" },
        { kind: "fragment_shader", source: "x".repeat(4_000) },
      ],
    }).ok).toBe(true);
    expect(parseStoreCommand({
      kind: "prompt",
      prompt: "Use this shader",
      expectedDraftVersionId: VERSION,
      attachments: [{ kind: "fragment_shader", source: "x".repeat(4_001) }],
    }).ok).toBe(false);
    expect(parseStoreCommand({
      kind: "prompt",
      prompt: "Change this",
      expectedDraftVersionId: VERSION,
      context: { routeId: "not-a-route", slot: "heroTitle" },
    }).ok).toBe(false);
  });
});
