import { describe, it, expect } from "vitest";
import { carrierTrackingUrl } from "../tracking-url";

describe("carrierTrackingUrl", () => {
  it("maps known carriers (case/format tolerant) to their tracking pages", () => {
    expect(carrierTrackingUrl("USPS", "9400111899223")).toContain("tools.usps.com");
    expect(carrierTrackingUrl("usps priority", "9400111899223")).toContain("tools.usps.com");
    expect(carrierTrackingUrl("UPS", "1Z999AA10123456784")).toContain("ups.com");
    expect(carrierTrackingUrl("FedEx Ground", "123456789012")).toContain("fedex.com");
    expect(carrierTrackingUrl("DHL Express", "1234567890")).toContain("dhl.com");
    expect(carrierTrackingUrl("Canada Post", "1234567890123456")).toContain("canadapost");
  });

  it("returns null for unknown carriers or missing inputs", () => {
    expect(carrierTrackingUrl("Pony Express", "123456")).toBeNull();
    expect(carrierTrackingUrl(null, "123456")).toBeNull();
    expect(carrierTrackingUrl("USPS", null)).toBeNull();
    expect(carrierTrackingUrl("USPS", "")).toBeNull();
  });

  it("refuses tracking numbers that could break out of the URL slot", () => {
    expect(carrierTrackingUrl("USPS", "12<script>34")).toBeNull();
    expect(carrierTrackingUrl("USPS", "123?x=1")).toBeNull();
    expect(carrierTrackingUrl("USPS", "abc")).toBeNull(); // too short to be real
  });
});
