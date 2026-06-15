import { describe, it, expect } from "vitest";
import { parseInviteInput } from "../validate";

describe("parseInviteInput", () => {
  it("accepts a valid body and lowercases the email", () => {
    const r = parseInviteInput({ email: "Jane@Store.com", first_name: " Jane ", store_name: "Jane's Goods" });
    expect(r).toEqual({ ok: true, value: { email: "jane@store.com", firstName: "Jane", storeName: "Jane's Goods", skipIfInvited: false } });
  });
  it("rejects a non-object body", () => {
    expect(parseInviteInput("nope")).toEqual({ ok: false, error: "body: expected a JSON object" });
  });
  it("rejects a bad email", () => {
    expect(parseInviteInput({ email: "x", first_name: "A", store_name: "B" })).toEqual({ ok: false, error: "email: invalid" });
  });
  it("rejects a blank first_name", () => {
    expect(parseInviteInput({ email: "a@b.co", first_name: "  ", store_name: "B" }).ok).toBe(false);
  });
  it("passes through skip_if_invited only when strictly true", () => {
    const r = parseInviteInput({ email: "a@b.co", first_name: "A", store_name: "B", skip_if_invited: true });
    expect(r.ok && r.value.skipIfInvited).toBe(true);
  });
});
