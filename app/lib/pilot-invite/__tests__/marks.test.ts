import { describe, it, expect } from "vitest";
import { pilotMarkTealResponse, pilotMarkWhiteResponse } from "../marks";

describe("logo responses", () => {
  it("serve PNG bytes with an immutable cache header", async () => {
    for (const res of [pilotMarkTealResponse(), pilotMarkWhiteResponse()]) {
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.length).toBeGreaterThan(100);
      // PNG magic number
      expect(Array.from(buf.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
