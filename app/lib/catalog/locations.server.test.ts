import { describe, expect, it } from "vitest";
import { validateNewLocation } from "./locations.server";

describe("validateNewLocation", () => {
  it("accepts a trimmed name and truncates priority to an integer", () => {
    expect(validateNewLocation({ name: "  Warehouse B ", priority: 2.9 })).toEqual({
      ok: true,
      value: { name: "Warehouse B", priority: 2 },
    });
  });

  it("rejects a blank or missing name", () => {
    expect(validateNewLocation({ name: "   " })).toEqual({ ok: false, code: "missing_name" });
    expect(validateNewLocation({})).toEqual({ ok: false, code: "missing_name" });
    expect(validateNewLocation(null)).toEqual({ ok: false, code: "missing_name" });
  });

  it("rejects names longer than 120 characters and accepts exactly 120", () => {
    expect(validateNewLocation({ name: "x".repeat(121) })).toEqual({ ok: false, code: "missing_name" });
    expect(validateNewLocation({ name: "x".repeat(120) })).toEqual({
      ok: true,
      value: { name: "x".repeat(120), priority: 0 },
    });
  });

  it("defaults a non-numeric or absent priority to 0", () => {
    expect(validateNewLocation({ name: "Shed", priority: "abc" })).toEqual({
      ok: true,
      value: { name: "Shed", priority: 0 },
    });
    expect(validateNewLocation({ name: "Shed" })).toEqual({
      ok: true,
      value: { name: "Shed", priority: 0 },
    });
  });
});
