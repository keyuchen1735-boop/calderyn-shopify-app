import { describe, expect, it } from "vitest";
import { buildSteps, canSendComposer, previewRouteId } from "./store-logic";

describe("Store command progress", () => {
  it("maps only the three merchant stages into ordered working rows", () => {
    expect(buildSteps({ kind: "running", stage: "understanding" }).map((row) => row.dot))
      .toEqual(["run", "wait", "wait"]);
    expect(buildSteps({ kind: "running", stage: "preparing_products" }).map((row) => row.dot))
      .toEqual(["done", "run", "wait"]);
    const checked = buildSteps({ kind: "running", stage: "checking_preview" });
    expect(checked.map((row) => row.dot)).toEqual(["done", "done", "run"]);
    expect(checked.map((row) => `${row.title} ${row.sub}`).join(" "))
      .not.toMatch(/recipe|template|compiler|runtime|custom/i);
  });

  it("maps redesign work to merchant-facing planning and page-building labels", () => {
    const planning = buildSteps({ kind: "running", stage: "planning_redesign" });
    const building = buildSteps({ kind: "running", stage: "building_pages" });

    expect(planning.find((row) => row.dot === "run")?.title).toBe("Planning the redesign");
    expect(building.find((row) => row.dot === "run")?.title).toBe("Building pages");
    expect([...planning, ...building].map((row) => `${row.title} ${row.sub}`).join(" "))
      .not.toMatch(/template|recipe|compiler|model/i);
  });

  it("keeps a failure honest", () => {
    expect(buildSteps({ kind: "failed", message: "Nothing changed." })).toEqual([
      expect.objectContaining({ dot: "wait", sub: "Nothing changed." }),
    ]);
  });
});

describe("command composer", () => {
  it("sends only non-empty prompts while idle", () => {
    expect(canSendComposer({ prompt: "make it warmer", busy: false })).toBe(true);
    expect(canSendComposer({ prompt: "   ", busy: false })).toBe(false);
    expect(canSendComposer({ prompt: "make it warmer", busy: true })).toBe(false);
  });
});

describe("preview route context", () => {
  it.each([
    ["home", "home"],
    ["pdp", "product"],
    ["collection", "collection"],
    ["page:about", undefined],
  ] as const)("maps %s without falling back to home", (page, routeId) => {
    expect(previewRouteId(page)).toBe(routeId);
  });
});
