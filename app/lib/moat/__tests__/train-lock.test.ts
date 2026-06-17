import { describe, it, expect } from "vitest";
import { acquireTrainLock, releaseTrainLock } from "../train-lock.server";

// The lock is a swappable seam (spec OQ-2/OQ-3). The shipped stub never blocks:
// acquire always grants, release always resolves. These tests pin that contract
// so a later run-row implementation has a behavior anchor to replace it against.
describe("train-lock (no-op stub)", () => {
  const sb = {} as never;

  it("acquire grants the lock (returns true)", async () => {
    await expect(acquireTrainLock(sb)).resolves.toBe(true);
  });

  it("release resolves without throwing", async () => {
    await expect(releaseTrainLock(sb)).resolves.toBeUndefined();
  });
});
