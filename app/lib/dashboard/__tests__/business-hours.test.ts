import { describe, it, expect } from "vitest";
import { tzOffsetHours, utcHourToLocal, localHourToUtc } from "../business-hours";

// Fixed reference instants so the test is independent of the run date.
const WINTER = new Date("2025-01-15T12:00:00Z"); // America/New_York = EST (UTC-5)
const SUMMER = new Date("2025-07-15T12:00:00Z"); // America/New_York = EDT (UTC-4)

describe("tzOffsetHours", () => {
  it("is -5 for New York in winter and -4 in summer", () => {
    expect(tzOffsetHours("America/New_York", WINTER)).toBe(-5);
    expect(tzOffsetHours("America/New_York", SUMMER)).toBe(-4);
  });
  it("is 0 for UTC", () => {
    expect(tzOffsetHours("UTC", WINTER)).toBe(0);
  });
});

describe("utcHourToLocal", () => {
  it("renders the stored UTC hour as local wall-clock (winter)", () => {
    expect(utcHourToLocal(14, "America/New_York", WINTER)).toBe("09:00");
    expect(utcHourToLocal(0, "America/New_York", WINTER)).toBe("19:00");
  });
  it("shifts by one hour across DST (summer)", () => {
    expect(utcHourToLocal(14, "America/New_York", SUMMER)).toBe("10:00");
  });
});

describe("localHourToUtc", () => {
  it("is the inverse of utcHourToLocal (winter)", () => {
    expect(localHourToUtc("09:00", "America/New_York", WINTER)).toBe(14);
    expect(localHourToUtc("19:00", "America/New_York", WINTER)).toBe(0);
  });
  it("round-trips for every whole hour in a whole-hour zone", () => {
    for (let h = 0; h < 24; h++) {
      const local = utcHourToLocal(h, "America/New_York", WINTER);
      expect(localHourToUtc(local, "America/New_York", WINTER)).toBe(h);
    }
  });
});
