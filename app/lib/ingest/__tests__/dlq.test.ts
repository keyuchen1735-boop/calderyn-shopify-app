import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn(async () => ({ error: null }));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert }) }),
}));

import { writeDlq } from "../dlq.server";

beforeEach(() => insert.mockClear());

describe("writeDlq", () => {
  it("defaults connector to shopify", async () => {
    await writeDlq({ shopId: "s1", jobKind: "backfill", errorKind: "x", errorMessage: "boom", payload: {} });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ connector: "shopify", job_kind: "backfill" }));
  });

  it("uses the provided connector", async () => {
    await writeDlq({ shopId: "s1", connector: "meta", jobKind: "poll", errorKind: "x", errorMessage: "boom", payload: {} });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ connector: "meta", job_kind: "poll" }));
  });
});
