import { describe, expect, it } from "vitest";
import { buildPrefillParam, isPrefillParam, parsePrefillParam } from "../order-composer-prefill";

const ORDER_ID = "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const RETURN_ID = "9f9a2b1c-2222-4e5f-8a9b-0c1d2e3f4a5b";

describe("buildPrefillParam / parsePrefillParam", () => {
  it("round-trips an order id + return id", () => {
    const param = buildPrefillParam(ORDER_ID, RETURN_ID);
    expect(parsePrefillParam(param)).toEqual({ orderId: ORDER_ID, returnId: RETURN_ID });
  });

  it("is distinct from the bare 'new' composer param", () => {
    expect(isPrefillParam("new")).toBe(false);
    expect(parsePrefillParam("new")).toBeNull();
  });

  it("recognizes any new_-prefixed param via isPrefillParam, even a malformed one", () => {
    expect(isPrefillParam("new_garbage")).toBe(true);
  });

  it("returns null for a malformed prefill (no separator)", () => {
    expect(parsePrefillParam("new_onlyoneid")).toBeNull();
  });

  it("returns null for a prefill missing the return id half", () => {
    expect(parsePrefillParam(`new_${ORDER_ID}_`)).toBeNull();
  });

  it("returns null for a prefill missing the order id half", () => {
    expect(parsePrefillParam(`new__${RETURN_ID}`)).toBeNull();
  });

  it("returns null for an unrelated param (an order sourceId, not a prefill)", () => {
    expect(parsePrefillParam(ORDER_ID)).toBeNull();
  });
});
