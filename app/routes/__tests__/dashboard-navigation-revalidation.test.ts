import { describe, expect, it } from "vitest";

describe("dashboard screen navigation", () => {
  it("does not revalidate the shared loader when only the screen URL changes", async () => {
    const route = (await import("../dashboard.$")) as Record<string, unknown>;
    const shouldRevalidate = route.shouldRevalidate as (args: {
      currentUrl: URL;
      nextUrl: URL;
      defaultShouldRevalidate: boolean;
    }) => boolean;

    expect(shouldRevalidate).toBeTypeOf("function");
    expect(
      shouldRevalidate({
        currentUrl: new URL("https://app.calderyncompany.com/dashboard"),
        nextUrl: new URL("https://app.calderyncompany.com/dashboard/orders"),
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });
});
