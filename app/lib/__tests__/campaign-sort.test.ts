import { describe, expect, test } from "vitest";
import { DEFAULT_CAMPAIGN_SORT, orderCampaigns, sortActiveFirst } from "../campaign-sort";

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

const row = (
  name: string,
  over: Partial<{
    status: string;
    daily_budget_cents: number;
    spend_7d: number;
    roas_7d: number;
    score: number | null;
  }> = {},
) => ({
  name,
  status: over.status ?? "active",
  daily_budget_cents: over.daily_budget_cents ?? 0,
  spend_7d: over.spend_7d ?? 0,
  roas_7d: over.roas_7d ?? 0,
  calderynScore: over.score === undefined ? null : { value: over.score },
});

const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

describe("orderCampaigns — header column sorting", () => {
  test("the default keeps active above paused, highest spend first", () => {
    const sorted = orderCampaigns(
      [
        row("paused-hi", { status: "paused", spend_7d: 900 }),
        row("active-lo", { spend_7d: 10 }),
        row("active-hi", { spend_7d: 800 }),
      ],
      DEFAULT_CAMPAIGN_SORT,
    );
    expect(names(sorted)).toEqual(["active-hi", "active-lo", "paused-hi"]);
  });

  test("an explicit column sort spans the whole table, not each status group", () => {
    // A paused campaign with the best ROAS must be reachable at the top —
    // burying it under every active row would not answer "highest ROAS".
    const sorted = orderCampaigns(
      [
        row("active-mid", { roas_7d: 2 }),
        row("paused-best", { status: "paused", roas_7d: 9 }),
        row("active-low", { roas_7d: 1 }),
      ],
      { sort: "roas", dir: "desc" },
    );
    expect(names(sorted)).toEqual(["paused-best", "active-mid", "active-low"]);
  });

  test("Daily falls back to the 7-day average when no budget is set", () => {
    const sorted = orderCampaigns(
      [
        row("avg-700", { spend_7d: 700 }), // 100/day
        row("budget-50", { daily_budget_cents: 50 }),
      ],
      { sort: "daily", dir: "desc" },
    );
    expect(names(sorted)).toEqual(["avg-700", "budget-50"]);
  });

  test("rows with no daily figure at all sink to the bottom in both directions", () => {
    const rows = [row("none"), row("has", { daily_budget_cents: 10 })];
    expect(names(orderCampaigns(rows, { sort: "daily", dir: "desc" }))).toEqual(["has", "none"]);
    expect(names(orderCampaigns(rows, { sort: "daily", dir: "asc" }))).toEqual(["has", "none"]);
  });

  test("unscored campaigns sink to the bottom in both directions", () => {
    // A pending score is an unknown, not a zero — floating it to the top of an
    // ascending sort would bury the genuinely worst performer.
    const rows = [row("unscored"), row("low", { score: 10 }), row("high", { score: 90 })];
    expect(names(orderCampaigns(rows, { sort: "score", dir: "asc" }))).toEqual([
      "low",
      "high",
      "unscored",
    ]);
    expect(names(orderCampaigns(rows, { sort: "score", dir: "desc" }))).toEqual([
      "high",
      "low",
      "unscored",
    ]);
  });

  test("equal values fall back to name so the order is stable", () => {
    const sorted = orderCampaigns(
      [row("zebra", { roas_7d: 3 }), row("apple", { roas_7d: 3 })],
      { sort: "roas", dir: "desc" },
    );
    expect(names(sorted)).toEqual(["apple", "zebra"]);
  });

  test("does not mutate the caller's array", () => {
    const input = [row("b"), row("a")];
    const before = names(input);
    orderCampaigns(input, { sort: "campaign", dir: "asc" });
    expect(names(input)).toEqual(before);
  });
});
