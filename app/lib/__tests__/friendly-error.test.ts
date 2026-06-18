import { describe, it, expect } from "vitest";
import { friendlyActionError, isUuid, displayAuditTarget } from "../friendly-error";

// P2-12: merchants must never see raw provider error strings or raw UUIDs in the
// action history; the raw text stays behind the details expansion.
describe("friendlyActionError", () => {
  it("maps a Meta 'object does not exist' (code 100) error to a human message", () => {
    const out = friendlyActionError(
      "Meta API error: Unsupported post request. Object with ID '120247426477610026' does not exist (code 100)",
    );
    expect(out).toMatch(/deleted|changed/i);
    expect(out).not.toMatch(/code 100|graph|facebook/i);
  });

  it("maps an unapproved developer token", () => {
    expect(friendlyActionError("DEVELOPER_TOKEN_NOT_APPROVED")).toMatch(/approved/i);
  });

  it("maps a rate limit to a retry message", () => {
    expect(friendlyActionError("OVER_QPS_LIMIT")).toMatch(/busy|retry/i);
  });

  it("returns null for no error", () => {
    expect(friendlyActionError(null)).toBeNull();
    expect(friendlyActionError("")).toBeNull();
  });
});

describe("displayAuditTarget", () => {
  it("hides a bare UUID instead of showing it raw", () => {
    expect(isUuid("3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(displayAuditTarget("3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("");
  });

  it("passes a real name through", () => {
    expect(displayAuditTarget("Summit Logo Tee")).toBe("Summit Logo Tee");
    expect(isUuid("Summit Logo Tee")).toBe(false);
  });
});
