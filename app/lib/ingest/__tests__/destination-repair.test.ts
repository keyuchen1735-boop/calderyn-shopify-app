import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchOrderDestinationsByIds = vi.fn();

vi.mock("../shopify-admin.server", () => ({ fetchOrderDestinationsByIds }));

type OrderRow = {
  id?: string;
  shop_id: string;
  external_id: string;
  customer_city: string | null;
  customer_region: string | null;
  customer_country: string | null;
};

function fakeSupabase(
  rows: OrderRow[],
  updateErrors: Array<Error | null> = [],
  updateResults: Array<unknown[] | undefined> = [],
) {
  const updates: Array<{
    table: string;
    payload: Record<string, unknown>;
    filters: unknown[];
  }> = [];
  const limits: number[] = [];
  let updateIndex = 0;

  return {
    updates,
    limits,
    client: {
      from(table: string) {
        let operation: "select" | "update" = "select";
        let payload: Record<string, unknown> = {};
        const filters: unknown[] = [];
        const chain = {
          select() {
            if (operation !== "update") operation = "select";
            return chain;
          },
          update(next: Record<string, unknown>) {
            operation = "update";
            payload = next;
            return chain;
          },
          eq(column: string, value: unknown) {
            filters.push(["eq", column, value]);
            return chain;
          },
          in(column: string, value: unknown[]) {
            filters.push(["in", column, value]);
            return chain;
          },
          gte(column: string, value: unknown) {
            filters.push(["gte", column, value]);
            return chain;
          },
          or(value: string) {
            filters.push(["or", value]);
            return chain;
          },
          is(column: string, value: unknown) {
            filters.push(["is", column, value]);
            return chain;
          },
          like(column: string, value: unknown) {
            filters.push(["like", column, value]);
            return chain;
          },
          order(column: string, value: unknown) {
            filters.push(["order", column, value]);
            return chain;
          },
          limit(value: number) {
            limits.push(value);
            return chain;
          },
          then(
            resolve: (value: { data: unknown; error: Error | null }) => unknown,
          ) {
            if (operation === "select") {
              return Promise.resolve(resolve({ data: rows, error: null }));
            }
            updates.push({ table, payload, filters: [...filters] });
            const resultIndex = updateIndex++;
            const error = updateErrors[resultIndex] ?? null;
            const affected = error
              ? null
              : (updateResults[resultIndex] ?? [
                  { id: rows[0]?.id ?? "order-1", shop_id: integration.shopId },
                ]);
            return Promise.resolve(resolve({ data: affected, error }));
          },
        };
        return chain;
      },
    },
  };
}

const integration = {
  shopId: "shop-1",
  shopDomain: "one.myshopify.com",
  claimedAt: "2026-07-13T11:59:00.000Z",
};

describe("repairOrderDestinationsForIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
  });

  it("updates only missing destination columns for matching recent order rows", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([
      {
        id: "gid://shopify/Order/1",
        city: " Toronto ",
        region: "ON",
        country: "CA",
      },
    ]);
    const sb = fakeSupabase([
      {
        shop_id: "shop-1",
        external_id: "gid://shopify/Order/1",
        customer_city: null,
        customer_region: "ON",
        customer_country: null,
      },
    ]);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    const result = await repairOrderDestinationsForIntegration(
      integration,
      sb.client as never,
    );

    expect(fetchOrderDestinationsByIds).toHaveBeenCalledWith(
      "one.myshopify.com",
      ["gid://shopify/Order/1"],
    );
    expect(result).toMatchObject({
      scanned: 1,
      updated: 1,
      checked: 1,
      completed: true,
    });
    expect(sb.limits).toContain(11);

    const orderWrites = sb.updates.filter(
      (write) => write.table === "order_fact",
    );
    const orderUpdate = orderWrites[0];
    expect(orderUpdate?.payload).toEqual({
      customer_city: "Toronto",
      customer_country: "CA",
    });
    expect(orderUpdate?.payload).not.toHaveProperty("landing_site");
    expect(orderUpdate?.payload).not.toHaveProperty("utm_source");
    expect(orderUpdate?.payload).not.toHaveProperty("source_version");
    expect(orderUpdate?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "shop_id", "shop-1"],
        ["eq", "external_id", "gid://shopify/Order/1"],
        ["is", "customer_city", null],
        ["is", "customer_country", null],
      ]),
    );
    expect(orderWrites[1].payload).toEqual({
      destination_repair_checked_at: "2026-07-13T12:00:00.000Z",
    });
  });

  it("checks no-address orders so they cannot monopolize later runs", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([
      { id: "gid://shopify/Order/1", city: null, region: null, country: null },
    ]);
    const sb = fakeSupabase([
      {
        shop_id: "shop-1",
        external_id: "gid://shopify/Order/1",
        customer_city: null,
        customer_region: null,
        customer_country: null,
      },
    ]);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    const result = await repairOrderDestinationsForIntegration(
      integration,
      sb.client as never,
    );

    expect(result).toMatchObject({
      scanned: 1,
      updated: 0,
      checked: 1,
      completed: true,
    });
    expect(
      sb.updates.filter((write) => write.table === "order_fact"),
    ).toHaveLength(1);
    expect(
      sb.updates.find((write) => write.table === "order_fact")?.payload,
    ).toEqual({
      destination_repair_checked_at: "2026-07-13T12:00:00.000Z",
    });
    expect(
      sb.updates.find((write) => write.table === "shop_integrations")?.payload,
    ).toEqual({
      destination_repair_completed_at: "2026-07-13T12:00:00.000Z",
    });
  });

  it("leaves the checked marker null when a destination write fails so the row is retryable", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([
      {
        id: "gid://shopify/Order/1",
        city: "Toronto",
        region: "ON",
        country: "CA",
      },
    ]);
    const row = {
      shop_id: "shop-1",
      external_id: "gid://shopify/Order/1",
      customer_city: null,
      customer_region: null,
      customer_country: null,
    };
    const failed = fakeSupabase([row], [new Error("write failed")]);
    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");

    await expect(
      repairOrderDestinationsForIntegration(
        integration,
        failed.client as never,
      ),
    ).rejects.toThrow("write failed");
    expect(
      failed.updates.find((write) => write.table === "shop_integrations"),
    ).toBeUndefined();

    const retried = fakeSupabase([row]);
    await repairOrderDestinationsForIntegration(
      integration,
      retried.client as never,
    );
    expect(fetchOrderDestinationsByIds).toHaveBeenLastCalledWith(
      "one.myshopify.com",
      ["gid://shopify/Order/1"],
    );
    expect(
      retried.updates.find((write) => write.table === "shop_integrations")
        ?.payload,
    ).toMatchObject({
      destination_repair_completed_at: "2026-07-13T12:00:00.000Z",
    });
  });

  it("leaves every order unchecked when the Admin API batch fails", async () => {
    fetchOrderDestinationsByIds.mockRejectedValue(
      new Error("Shopify unavailable"),
    );
    const sb = fakeSupabase([
      {
        shop_id: "shop-1",
        external_id: "gid://shopify/Order/1",
        customer_city: null,
        customer_region: null,
        customer_country: null,
      },
    ]);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    await expect(
      repairOrderDestinationsForIntegration(integration, sb.client as never),
    ).rejects.toThrow("Shopify unavailable");

    expect(
      sb.updates.filter((write) => write.table === "order_fact"),
    ).toHaveLength(0);
    expect(
      sb.updates.find((write) => write.table === "shop_integrations"),
    ).toBeUndefined();
  });

  it("never sends malformed external IDs to Shopify and checks them as terminal local rows", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([
      {
        id: "gid://shopify/Order/2",
        city: "Ottawa",
        region: "ON",
        country: "CA",
      },
    ]);
    const sb = fakeSupabase([
      {
        shop_id: "shop-1",
        external_id: "gid://shopify/Order/not-an-id",
        customer_city: null,
        customer_region: null,
        customer_country: null,
      },
      {
        shop_id: "shop-1",
        external_id: "gid://shopify/Order/2",
        customer_city: null,
        customer_region: null,
        customer_country: null,
      },
    ]);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    const result = await repairOrderDestinationsForIntegration(
      integration,
      sb.client as never,
    );

    expect(fetchOrderDestinationsByIds).toHaveBeenCalledWith(
      "one.myshopify.com",
      ["gid://shopify/Order/2"],
    );
    expect(result).toMatchObject({ scanned: 2, checked: 2, completed: true });
  });

  it("caps each shop batch and leaves the integration incomplete for a fair later pass", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      shop_id: "shop-1",
      external_id: `gid://shopify/Order/${index + 1}`,
      customer_city: null,
      customer_region: null,
      customer_country: null,
    }));
    fetchOrderDestinationsByIds.mockResolvedValue([]);
    const sb = fakeSupabase(rows);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    const result = await repairOrderDestinationsForIntegration(
      integration,
      sb.client as never,
    );

    expect(fetchOrderDestinationsByIds.mock.calls[0][1]).toHaveLength(10);
    expect(result).toMatchObject({
      scanned: 10,
      checked: 10,
      completed: false,
    });
    expect(
      sb.updates.find((write) => write.table === "shop_integrations"),
    ).toBeUndefined();
  });

  it("counts only rows actually affected by fenced updates", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([
      {
        id: "gid://shopify/Order/1",
        city: "Toronto",
        region: "ON",
        country: "CA",
      },
    ]);
    const sb = fakeSupabase(
      [
        {
          id: "order-1",
          shop_id: "shop-1",
          external_id: "gid://shopify/Order/1",
          customer_city: null,
          customer_region: null,
          customer_country: null,
        },
      ],
      [],
      [[], [], [{ shop_id: "shop-1" }]],
    );

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    const result = await repairOrderDestinationsForIntegration(
      integration,
      sb.client as never,
    );

    expect(result).toMatchObject({ scanned: 1, updated: 0, checked: 0 });
  });

  it("fences completion progress to the exact claimed Shopify tenant row", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([]);
    const sb = fakeSupabase([]);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");
    await repairOrderDestinationsForIntegration(
      integration,
      sb.client as never,
    );

    const progress = sb.updates.find(
      (write) => write.table === "shop_integrations",
    );
    expect(progress?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "shop_id", "shop-1"],
        ["eq", "kind", "shopify"],
        ["eq", "destination_repair_attempted_at", "2026-07-13T11:59:00.000Z"],
      ]),
    );
  });

  it("fails visibly when claimed completion affects no integration row", async () => {
    fetchOrderDestinationsByIds.mockResolvedValue([]);
    const sb = fakeSupabase([], [], [[]]);

    const { repairOrderDestinationsForIntegration } =
      await import("../destination-repair.server");

    await expect(
      repairOrderDestinationsForIntegration(integration, sb.client as never),
    ).rejects.toThrow("destination repair claim lost for shop shop-1");
  });
});
