import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAcpSignature } from "./signature.server";

const SECRET = "whsec_test";
const body = JSON.stringify({ a: 1 });
const good = createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyAcpSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyAcpSignature(body, good, SECRET)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyAcpSignature(JSON.stringify({ a: 2 }), good, SECRET)).toBe(false);
  });
  it("rejects a missing/garbage signature without throwing", () => {
    expect(verifyAcpSignature(body, "", SECRET)).toBe(false);
    expect(verifyAcpSignature(body, "deadbeef", SECRET)).toBe(false);
  });
});
