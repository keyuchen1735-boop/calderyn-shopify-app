// Regression test for the 2026-06-10 production outage (FUNCTION_INVOCATION_FAILED).
// image-slot.tsx is pulled into the Remix *server* bundle via the side-effect
// import in screens/Generator.tsx and screens/Predictor.tsx. Vitest runs with
// environment: "node" (no DOM), same as the Vercel lambda — importing the
// module must not touch browser globals at module scope.
import { describe, expect, it } from "vitest";

describe("image-slot SSR safety", () => {
  it("imports cleanly in a DOM-less Node environment", async () => {
    await expect(import("./image-slot")).resolves.toBeDefined();
  });
});
