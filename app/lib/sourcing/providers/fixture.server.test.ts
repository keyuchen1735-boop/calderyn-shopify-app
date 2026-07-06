// app/lib/sourcing/providers/fixture.server.test.ts
import { describe, it, expect } from "vitest";
import { fixtureAdapter } from "./fixture.server";

describe("fixtureAdapter", () => {
  it("returns normalized trending products capped at limit", async () => {
    const rows = await fixtureAdapter.getTrending(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("fx-1");
    expect(rows[0].supplier.name).toBe("Shenzhen HomeGoods");
    expect(rows[0].signals.find((s) => s.kind === "trend_index")?.value).toBe(88);
  });

  it("getProduct resolves by externalId, null when missing", async () => {
    expect((await fixtureAdapter.getProduct("fx-2"))?.title).toBe("LED Sunset Lamp");
    expect(await fixtureAdapter.getProduct("nope")).toBeNull();
  });
});
