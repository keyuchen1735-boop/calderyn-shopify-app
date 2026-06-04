import { describe, it, expect } from "vitest";
import { buildSystemPrompt, ASSISTANT_SYSTEM_INSTRUCTIONS } from "../prompt.server";

describe("buildSystemPrompt", () => {
  it("caches the static block and leaves the snapshot uncached", () => {
    const blocks = buildSystemPrompt("SNAPSHOT-XYZ");
    expect(blocks).toHaveLength(2);

    expect(blocks[0].text).toBe(ASSISTANT_SYSTEM_INSTRUCTIONS);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });

    expect(blocks[1].text).toBe("SNAPSHOT-XYZ");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("static instructions mention the cents->dollars rule and the alert-backed constraint", () => {
    expect(ASSISTANT_SYSTEM_INSTRUCTIONS.toLowerCase()).toContain("cents");
    expect(ASSISTANT_SYSTEM_INSTRUCTIONS.toLowerCase()).toContain("propose_action");
  });
});
