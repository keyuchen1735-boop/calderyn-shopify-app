import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const screen = (f: string) => new URL(`../screens/${f}`, import.meta.url);
const file = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("Predictor/Generator dashboard screens are removed", () => {
  it("Predictor.tsx and Generator.tsx screen files are deleted", () => {
    expect(existsSync(screen("Predictor.tsx"))).toBe(false);
    expect(existsSync(screen("Generator.tsx"))).toBe(false);
  });

  it("DashboardApp no longer imports or registers them", () => {
    const app = file("DashboardApp.tsx");
    expect(app).not.toContain("ScreenPredictor");
    expect(app).not.toContain("ScreenGenerator");
    expect(app).not.toMatch(/^\s*predictor:/m);
    expect(app).not.toMatch(/^\s*generator:/m);
  });

  it("the Screen union drops the predictor and generator members", () => {
    const ctx = file("context.ts");
    expect(ctx).not.toContain('"predictor"');
    expect(ctx).not.toContain('"generator"');
  });
});
