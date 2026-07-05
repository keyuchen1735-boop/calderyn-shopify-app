import { describe, it, expect } from "vitest";
import { buildSystemPrompt, ASSISTANT_SYSTEM_INSTRUCTIONS } from "../prompt.server";

describe("buildSystemPrompt", () => {
  it("caches both the static block and the snapshot block", () => {
    const blocks = buildSystemPrompt("SNAPSHOT-XYZ");
    expect(blocks).toHaveLength(2);

    expect(blocks[0].text).toBe(ASSISTANT_SYSTEM_INSTRUCTIONS);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });

    // Snapshot is fenced as data so shop-derived text can't read as
    // instructions; the content itself must ride inside unchanged.
    expect(blocks[1].text).toBe("<shop_snapshot>\nSNAPSHOT-XYZ\n</shop_snapshot>");
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("static instructions mention the cents->dollars rule and the alert-backed constraint", () => {
    expect(ASSISTANT_SYSTEM_INSTRUCTIONS.toLowerCase()).toContain("cents");
    expect(ASSISTANT_SYSTEM_INSTRUCTIONS.toLowerCase()).toContain("propose_action");
  });
});
