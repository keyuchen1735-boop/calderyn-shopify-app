// The post-OAuth redirect lands on /app/settings?<provider>=connected (or
// =error&reason=...). The settings page turns that into a one-shot App Bridge
// toast. These tests lock the pure notice -> toast mapping the hook renders.

import { describe, it, expect } from "vitest";
import { connectionToast } from "../toast";

describe("connectionToast", () => {
  it("maps a successful pairing notice to a success toast", () => {
    expect(connectionToast({ provider: "QuickBooks", ok: true })).toEqual({
      message: "QuickBooks connected",
      isError: false,
    });
  });

  it("maps a failed pairing notice to an error toast carrying the reason", () => {
    expect(connectionToast({ provider: "Meta Ads", ok: false, reason: "access_denied" })).toEqual({
      message: "Couldn't connect Meta Ads (access_denied)",
      isError: true,
    });
  });

  it("maps a failed pairing notice without a reason to a plain error toast", () => {
    expect(connectionToast({ provider: "Google Ads", ok: false })).toEqual({
      message: "Couldn't connect Google Ads",
      isError: true,
    });
  });

  it("returns null when there is no notice", () => {
    expect(connectionToast(null)).toBeNull();
  });
});
