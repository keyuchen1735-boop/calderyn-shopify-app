import { describe, it, expect } from "vitest";
import {
  friendlyActionError,
  friendlyIntegrationError,
  isUuid,
  displayAuditTarget,
} from "../friendly-error";

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

// Merchants must never see raw Google Ads / provider sync-error strings on the
// integration card. The raw text stays in shop_integrations.sync_error for
// support; the card shows this plain-language form (same principle as
// friendlyActionError / P2-12).
describe("friendlyIntegrationError", () => {
  const CUSTOMER_NOT_ENABLED =
    "Google Ads API error: The caller does not have permission — CUSTOMER_NOT_ENABLED: The customer account can't be accessed because it is not yet enabled or has been deactivated.";

  it("explains an inactive Google Ads account (CUSTOMER_NOT_ENABLED) in plain language", () => {
    const out = friendlyIntegrationError(CUSTOMER_NOT_ENABLED);
    expect(out).toMatch(/google ads account/i);
    expect(out).toMatch(/reconnect/i);
    // No raw API jargon leaks through.
    expect(out).not.toMatch(/CUSTOMER_NOT_ENABLED|caller does not have permission/i);
  });

  it("treats an unapproved developer token as a pending approval, not a merchant action", () => {
    const out = friendlyIntegrationError(
      "Google Ads API error: The caller does not have permission — authorizationError/DEVELOPER_TOKEN_NOT_APPROVED: apply for Basic or Standard access",
    );
    expect(out).toMatch(/approv/i);
    expect(out).not.toMatch(/DEVELOPER_TOKEN_NOT_APPROVED|permission/i);
  });

  it("maps an expired credential to a reconnect prompt", () => {
    const out = friendlyIntegrationError(
      "Google OAuth token exchange failed (invalid_grant): Token has been expired or revoked.",
    );
    expect(out).toMatch(/expired|reconnect/i);
    expect(out).not.toMatch(/invalid_grant/i);
  });

  it("does not downgrade an already-friendly 'access was revoked' message to the generic fallback", () => {
    // The QuickBooks cron records this sentence verbatim as sync_error (with
    // sync_status 'disconnected', which is NOT reauth) — it must stay a clear
    // reconnect prompt, not regress to the vaguer "...contact support" generic.
    const out = friendlyIntegrationError("QuickBooks access was revoked — reconnect to resume syncing.");
    expect(out).toMatch(/reconnect/i);
    expect(out).not.toMatch(/contact support/i);
  });

  it("falls back to a generic message for an unrecognized error, never the raw string", () => {
    const raw = "Google Ads API error: HTTP 500 unexpected internal failure xyz";
    const out = friendlyIntegrationError(raw);
    expect(out).toBeTruthy();
    expect(out).not.toBe(raw);
    expect(out).not.toMatch(/HTTP 500|xyz/i);
  });

  it("returns null when there is no error", () => {
    expect(friendlyIntegrationError(null)).toBeNull();
    expect(friendlyIntegrationError("")).toBeNull();
    expect(friendlyIntegrationError(undefined)).toBeNull();
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
