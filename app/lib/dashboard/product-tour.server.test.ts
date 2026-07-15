import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getProductTourState,
  recordProductTourOutcome,
} from "./product-tour.server";

const update = vi.fn();
const updateEq = vi.fn();
const select = vi.fn();
const selectEq = vi.fn();
const maybeSingle = vi.fn();

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ update, select }) }),
}));

beforeEach(() => {
  updateEq.mockReset().mockResolvedValue({ error: null });
  update.mockReset().mockReturnValue({ eq: updateEq });
  maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  selectEq.mockReset().mockReturnValue({ maybeSingle });
  select.mockReset().mockReturnValue({ eq: selectEq });
});

describe("product tour state", () => {
  it("is pending for a new first-party account", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: { product_tour_completed_at: null, product_tour_skipped_at: null },
      error: null,
    });
    await expect(getProductTourState("u1")).resolves.toEqual({
      pending: true,
      available: true,
    });
    expect(selectEq).toHaveBeenCalledWith("id", "u1");
  });

  it("stays hidden after either completion or a skip", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: {
        product_tour_completed_at: "2026-07-15T00:00:00Z",
        product_tour_skipped_at: null,
      },
      error: null,
    });
    await expect(getProductTourState("u1")).resolves.toEqual({
      pending: false,
      available: true,
    });

    maybeSingle.mockResolvedValueOnce({
      data: {
        product_tour_completed_at: null,
        product_tour_skipped_at: "2026-07-15T00:00:00Z",
      },
      error: null,
    });
    await expect(getProductTourState("u1")).resolves.toEqual({
      pending: false,
      available: true,
    });
  });

  it("does not offer the account tour to legacy shop sessions", async () => {
    await expect(getProductTourState(null)).resolves.toEqual({
      pending: false,
      available: false,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("fails closed during a rolling migration", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "column missing" },
    });
    await expect(getProductTourState("u1")).resolves.toEqual({
      pending: false,
      available: false,
    });
  });
});

describe("recordProductTourOutcome", () => {
  it("records completion without overwriting the skip history", async () => {
    await recordProductTourOutcome("u1", "complete");
    expect(update).toHaveBeenCalledWith({
      product_tour_completed_at: expect.any(String),
    });
    expect(updateEq).toHaveBeenCalledWith("id", "u1");
  });

  it("records a skip separately from completion", async () => {
    await recordProductTourOutcome("u1", "skip");
    expect(update).toHaveBeenCalledWith({
      product_tour_skipped_at: expect.any(String),
    });
  });

  it("surfaces write failures", async () => {
    updateEq.mockResolvedValueOnce({ error: { message: "write failed" } });
    await expect(recordProductTourOutcome("u1", "skip")).rejects.toBeTruthy();
  });
});
