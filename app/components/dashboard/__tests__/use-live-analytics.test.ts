// app/components/dashboard/__tests__/use-live-analytics.test.ts
import { describe, it, expect } from "vitest";
import { shouldPollNow } from "../use-live-analytics";

describe("shouldPollNow", () => {
  it("polls only when the subtab is active and the document is visible", () => {
    expect(shouldPollNow(true, "visible")).toBe(true);
    expect(shouldPollNow(true, "hidden")).toBe(false);
    expect(shouldPollNow(false, "visible")).toBe(false);
    expect(shouldPollNow(false, "hidden")).toBe(false);
  });
});
