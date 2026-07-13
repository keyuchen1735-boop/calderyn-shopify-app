import { describe, expect, it } from "vitest";
import {
  aggregateDestinationRows,
  normalizeDestinationPart,
  partitionDestinationRows,
  stableDestinationId,
  type DestinationOrderRow,
} from "../destination-aggregation";

interface SourceOrderRow extends DestinationOrderRow {
  order_id: string;
  buyer_id: string;
  created_at: string;
}

describe("destination aggregation", () => {
  it("normalizes accents, punctuation, case, and whitespace", () => {
    expect(normalizeDestinationPart("  Montréal—NORD  ")).toBe("montreal nord");
  });

  it("aggregates only caller-windowed rows, combines destinations, and sorts by order count", () => {
    const rows: SourceOrderRow[] = [
      {
        order_id: "order-recent-1",
        buyer_id: "buyer-secret-1",
        created_at: "2026-07-12T12:00:00Z",
        customer_city: " New York ",
        customer_region: " NY ",
        customer_country: " US ",
      },
      {
        order_id: "order-recent-2",
        buyer_id: "buyer-secret-2",
        created_at: "2026-06-20T12:00:00Z",
        customer_city: "new york",
        customer_region: "ny",
        customer_country: "us",
      },
      {
        order_id: "order-recent-3",
        buyer_id: "buyer-secret-3",
        created_at: "2026-07-01T12:00:00Z",
        customer_city: " Toronto ",
        customer_region: "Ontario",
        customer_country: "CA",
      },
      {
        order_id: "order-outside-window",
        buyer_id: "buyer-outside-window",
        created_at: "2026-05-01T12:00:00Z",
        customer_city: "Paris",
        customer_region: null,
        customer_country: "FR",
      },
    ];
    const windowStart = new Date("2026-06-13T00:00:00Z");
    const alreadyWindowedRows = rows.filter((row) => new Date(row.created_at) >= windowStart);

    const buckets = aggregateDestinationRows(alreadyWindowedRows);

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      city: "new york",
      region: "ny",
      country: "us",
      orderCount: 2,
    });
    expect(buckets.map((bucket) => bucket.orderCount)).toEqual([2, 1]);
    expect(buckets.some((bucket) => bucket.city === "paris")).toBe(false);
    expect(JSON.stringify(buckets)).not.toContain("order-recent");
    expect(JSON.stringify(buckets)).not.toContain("buyer-secret");
  });

  it("uses deterministic non-PII IDs derived from normalized destination parts", () => {
    const normalizedId = stableDestinationId("new york", "ny", "us");

    expect(stableDestinationId(" New York ", "NY", "US")).toBe(normalizedId);
    expect(normalizedId).toMatch(/^destination-[0-9a-f]{16}$/);
    expect(normalizedId).not.toContain("new-york");
    expect(normalizedId).not.toContain("order");
    expect(normalizedId).not.toContain("buyer");
  });

  it("keeps collision-safe groups separate with distinct 64-bit FNV IDs", () => {
    const rows: DestinationOrderRow[] = [
      { customer_city: "costarring", customer_region: "ON", customer_country: "CA" },
      { customer_city: "liquid", customer_region: "ON", customer_country: "CA" },
    ];

    expect(stableDestinationId("costarring", "on", "ca")).not.toBe(
      stableDestinationId("liquid", "on", "ca"),
    );
    expect(aggregateDestinationRows(rows)).toEqual([
      {
        id: stableDestinationId("costarring", "on", "ca"),
        city: "costarring",
        region: "on",
        country: "ca",
        orderCount: 1,
      },
      {
        id: stableDestinationId("liquid", "on", "ca"),
        city: "liquid",
        region: "on",
        country: "ca",
        orderCount: 1,
      },
    ]);
  });

  it("uses locale-independent code-unit ordering for tied destinations", () => {
    const rows: DestinationOrderRow[] = [
      { customer_city: "æble", customer_region: "", customer_country: "DK" },
      { customer_city: "zebra", customer_region: "", customer_country: "DK" },
      { customer_city: "alpha", customer_region: "", customer_country: "DK" },
    ];

    expect(aggregateDestinationRows(rows).map((bucket) => bucket.city)).toEqual([
      "alpha",
      "zebra",
      "æble",
    ]);
  });

  it("does not mutate its input array or rows", () => {
    const rows: readonly DestinationOrderRow[] = Object.freeze([
      Object.freeze({
        customer_city: " New York ",
        customer_region: " NY ",
        customer_country: " US ",
      }),
      Object.freeze({
        customer_city: "Toronto",
        customer_region: null,
        customer_country: "CA",
      }),
    ]);
    const before = JSON.parse(JSON.stringify(rows)) as DestinationOrderRow[];

    aggregateDestinationRows(rows);

    expect(rows).toEqual(before);
  });

  it("counts rows with missing city or country separately", () => {
    const rows: DestinationOrderRow[] = [
      { customer_city: "New York", customer_region: "NY", customer_country: "US" },
      { customer_city: null, customer_region: "NY", customer_country: "US" },
      { customer_city: "   ", customer_region: "ON", customer_country: "CA" },
      { customer_city: "Toronto", customer_region: "ON", customer_country: null },
      { customer_city: "Paris", customer_region: null, customer_country: "FR" },
    ];

    expect(partitionDestinationRows(rows)).toEqual({
      buckets: [
        {
          id: stableDestinationId("new york", "ny", "us"),
          city: "new york",
          region: "ny",
          country: "us",
          orderCount: 1,
        },
        {
          id: stableDestinationId("paris", "", "fr"),
          city: "paris",
          region: "",
          country: "fr",
          orderCount: 1,
        },
      ],
      incompleteOrderCount: 3,
    });
  });
});
