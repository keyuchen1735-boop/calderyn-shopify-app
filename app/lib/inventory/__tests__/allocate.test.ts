import { describe, it, expect } from "vitest";
import { orderLocations } from "../allocate";

const TO = { id: "to", priority: 0, lat: 43.65, lng: -79.38 };  // Toronto
const VAN = { id: "van", priority: 1, lat: 49.28, lng: -123.12 }; // Vancouver

describe("orderLocations", () => {
  it("falls back to priority order when there is no destination", () => {
    expect(orderLocations([VAN, TO], null)).toEqual(["to", "van"]);
  });
  it("orders nearest-to-destination when coords exist", () => {
    // A buyer near Vancouver -> Vancouver first.
    expect(orderLocations([TO, VAN], { lat: 49.2, lng: -123.0 })).toEqual(["van", "to"]);
  });
  it("sinks coord-less locations below located ones, then by priority", () => {
    const noGeo = { id: "x", priority: 2, lat: null, lng: null };
    expect(orderLocations([noGeo, TO], { lat: 43.6, lng: -79.4 })).toEqual(["to", "x"]);
  });
});
