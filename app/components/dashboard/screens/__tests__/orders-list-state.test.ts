import { describe, expect, it } from "vitest";
import {
  isSystemView,
  paramsToViewFilters,
  resolveViewFilters,
  stateToParams,
  systemViewParams,
  viewFiltersToParams,
  type ListState,
} from "../orders-list-state";
import type { OrderViewVM } from "~/lib/dashboard/orders-client";

describe("systemViewParams", () => {
  it("maps unfulfilled to a fulfillment_status filter", () => {
    expect(systemViewParams("unfulfilled")).toEqual({ fulfillmentStatus: "unfulfilled" });
  });

  it("maps unpaid to the three not-fully-paid payment statuses", () => {
    expect(systemViewParams("unpaid")).toEqual({
      paymentStatus: ["pending", "authorized", "partially_paid"],
    });
  });

  it("maps archived to archived:true", () => {
    expect(systemViewParams("archived")).toEqual({ archived: true });
  });

  it("carries no fixed filters for all", () => {
    expect(systemViewParams("all")).toEqual({});
  });
});

describe("isSystemView", () => {
  it("recognizes the four fixed tabs", () => {
    expect(isSystemView("all")).toBe(true);
    expect(isSystemView("unfulfilled")).toBe(true);
    expect(isSystemView("unpaid")).toBe(true);
    expect(isSystemView("archived")).toBe(true);
  });

  it("rejects a saved-view uuid", () => {
    expect(isSystemView("3f9c9b1e-1234-4a1a-8b1b-000000000000")).toBe(false);
  });
});

describe("viewFiltersToParams", () => {
  it("maps every known snake_case key to its camelCase OrdersListParams field", () => {
    expect(
      viewFiltersToParams({
        search: "acme",
        payment_status: ["paid", "partially_refunded"],
        fulfillment_status: "unfulfilled",
        source: "shopify",
        date_from: "2026-01-01",
        date_to: "2026-02-01",
        tag: "vip",
        archived: true,
        sort: "total",
        dir: "asc",
      }),
    ).toEqual({
      search: "acme",
      paymentStatus: ["paid", "partially_refunded"],
      fulfillmentStatus: "unfulfilled",
      source: "shopify",
      dateFrom: "2026-01-01",
      dateTo: "2026-02-01",
      tag: "vip",
      archived: true,
      sort: "total",
      dir: "asc",
    });
  });

  it("ignores unknown/stale keys instead of throwing", () => {
    expect(viewFiltersToParams({ search: "x", some_removed_field: "y" })).toEqual({ search: "x" });
  });

  it("returns an empty object for an empty blob", () => {
    expect(viewFiltersToParams({})).toEqual({});
  });

  it("drops empty strings and empty arrays rather than passing them through", () => {
    expect(viewFiltersToParams({ search: "", payment_status: [], tag: "" })).toEqual({});
  });
});

describe("paramsToViewFilters", () => {
  it("is the inverse of viewFiltersToParams for a full filter set", () => {
    const filters = {
      search: "acme",
      payment_status: ["paid", "partially_refunded"],
      fulfillment_status: "unfulfilled",
      source: "shopify",
      date_from: "2026-01-01",
      date_to: "2026-02-01",
      tag: "vip",
      archived: true,
      sort: "total",
      dir: "asc",
    };
    expect(paramsToViewFilters(viewFiltersToParams(filters))).toEqual(filters);
  });

  it("never emits offset or limit", () => {
    const out = paramsToViewFilters({ search: "acme", offset: 50, limit: 20 } as never);
    expect(out).toEqual({ search: "acme" });
  });

  it("omits undefined/empty fields", () => {
    expect(paramsToViewFilters({ paymentStatus: [], search: undefined })).toEqual({});
  });
});

const baseState: ListState = {
  view: "all",
  search: "",
  sort: undefined,
  dir: undefined,
  offset: 0,
};

describe("resolveViewFilters", () => {
  it("resolves a system tab to its fixed filters", () => {
    expect(resolveViewFilters("unfulfilled", [])).toEqual({ fulfillmentStatus: "unfulfilled" });
  });

  it("resolves a known saved-view id to its decoded filters", () => {
    const savedViews: OrderViewVM[] = [
      { id: "v1", name: "VIP", filters: { source: "shopify" }, position: 0 },
    ];
    expect(resolveViewFilters("v1", savedViews)).toEqual({ source: "shopify" });
  });

  it("resolves an unknown saved-view id to no extra filters", () => {
    expect(resolveViewFilters("stale-id", [])).toEqual({});
  });
});

describe("stateToParams", () => {
  it("passes manual filters through untouched on the 'all' view", () => {
    const state: ListState = { ...baseState, source: "shopify", dateFrom: "2026-01-01" };
    expect(stateToParams(state, [])).toEqual(
      expect.objectContaining({ source: "shopify", dateFrom: "2026-01-01" }),
    );
  });

  it("a system tab's own filter dimension overrides a manual control on that same dimension", () => {
    const state: ListState = { ...baseState, view: "unfulfilled", fulfillmentStatus: "fulfilled" };
    expect(stateToParams(state, []).fulfillmentStatus).toBe("unfulfilled");
  });

  it("a system tab leaves every OTHER manual filter dimension untouched", () => {
    const state: ListState = { ...baseState, view: "unfulfilled", source: "shopify" };
    const params = stateToParams(state, []);
    expect(params.fulfillmentStatus).toBe("unfulfilled");
    expect(params.source).toBe("shopify");
  });

  it("search/sort/dir/offset always come from live state, even when a saved view stores its own", () => {
    const savedViews: OrderViewVM[] = [
      { id: "v1", name: "Saved", filters: { sort: "total", dir: "asc" }, position: 0 },
    ];
    const state: ListState = { ...baseState, view: "v1", sort: "customer", dir: "desc", offset: 50 };
    const params = stateToParams(state, savedViews);
    expect(params.sort).toBe("customer");
    expect(params.dir).toBe("desc");
    expect(params.offset).toBe(50);
  });
});
