import { describe, expect, it } from "vitest";
import { remixFutureFlags } from "../../../vite.config";

describe("storefront checkout transport", () => {
  it("keeps single-fetch streaming disabled so checkout hydration cannot outrun its data", () => {
    expect(remixFutureFlags).not.toHaveProperty("v3_singleFetch");
  });
});
