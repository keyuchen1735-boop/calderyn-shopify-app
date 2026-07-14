import { describe, expect, it } from "vitest";
import { COMPILER_SYSTEM_PROMPT } from "./prompts";

describe("COMPILER_SYSTEM_PROMPT", () => {
  it("distinguishes repeater source attributes from compiler-owned output markers", () => {
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-repeat");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-key");
    expect(COMPILER_SYSTEM_PROMPT).toContain("Never emit compiler-owned output markers");
    expect(COMPILER_SYSTEM_PROMPT).toContain("data-cd-repeat-id");
  });
});
