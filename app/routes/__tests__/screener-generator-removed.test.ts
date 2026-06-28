import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const route = (f: string) => new URL(`../${f}`, import.meta.url);

describe("Predictor/Generator embedded routes are removed", () => {
  it("app.screener.tsx and app.generator.tsx no longer exist", () => {
    expect(existsSync(route("app.screener.tsx"))).toBe(false);
    expect(existsSync(route("app.generator.tsx"))).toBe(false);
  });

  it("the embedded NavMenu has no Creative Predictor / Ad Generator links", () => {
    const appTsx = readFileSync(route("app.tsx"), "utf8");
    expect(appTsx).not.toContain("/app/screener");
    expect(appTsx).not.toContain("/app/generator");
  });
});
