import { describe, expect, test } from "vitest";
import { sortActiveFirst } from "../campaign-sort";

const c = (name: string, status: string, spend_7d = 0) => ({ name, status, spend_7d });

describe("sortActiveFirst — active campaigns float above paused", () => {
  test("active rows come before paused regardless of input order", () => {
    const sorted = sortActiveFirst([
      c("paused-1", "paused"),
      c("active-1", "active"),
      c("paused-2", "paused"),
      c("active-2", "active"),
    ]);
    expect(sorted.map((x) => x.status)).toEqual(["active", "active", "paused", "paused"]);
  });

  test("orders rows within each status group by the tiebreak (spend desc)", () => {
    const bySpendDesc = (a: { spend_7d: number }, b: { spend_7d: number }) =>
      b.spend_7d - a.spend_7d;
    const sorted = sortActiveFirst(
      [
        c("active-lo", "active", 100),
        c("paused-hi", "paused", 900),
        c("active-hi", "active", 800),
        c("paused-lo", "paused", 50),
      ],
      bySpendDesc,
    );
    expect(sorted.map((x) => x.name)).toEqual([
      "active-hi", // active group, higher spend first
      "active-lo",
      "paused-hi", // paused group, higher spend first — still below all active
      "paused-lo",
    ]);
  });

  test("does not mutate the caller's array", () => {
    const input = [c("a", "paused"), c("b", "active")];
    const before = input.map((x) => x.name);
    sortActiveFirst(input);
    expect(input.map((x) => x.name)).toEqual(before);
  });

  test("with no tiebreak, preserves input order within each status group (stable)", () => {
    const sorted = sortActiveFirst([
      c("a", "active"),
      c("p1", "paused"),
      c("b", "active"),
      c("p2", "paused"),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(["a", "b", "p1", "p2"]);
  });
});
