import { describe, it, expect } from "vitest";
import {
  APIKEY_PROVIDERS,
  OAUTH_PROVIDERS,
  connectionNotice,
  isApiKeyConnect,
  isConnectable,
  kindToProvider,
} from "../integrations";

// EasyPost is the first API-KEY (paste) connector, not OAuth (contract C8). These
// guard that the maps + branch helpers route it down the key-form path on the
// settings card and never offer it the OAuth Connect button.

describe("EasyPost API-key connect routing", () => {
  it("maps the easypost_ship kind to its 'easypost' provider short name", () => {
    expect(kindToProvider("easypost_ship")).toBe("easypost");
  });

  it("is NOT OAuth-connectable — it must not render the OAuth Connect button", () => {
    expect(isConnectable("easypost_ship")).toBe(false);
    expect((OAUTH_PROVIDERS as readonly string[]).includes("easypost")).toBe(false);
  });

  it("IS an API-key connector — the card renders the inline key field for it", () => {
    expect(isApiKeyConnect("easypost_ship")).toBe(true);
    expect((APIKEY_PROVIDERS as readonly string[]).includes("easypost")).toBe(true);
  });

  it("keeps OAuth and API-key connect mechanisms mutually exclusive", () => {
    // No kind should be both. (Spot-check the providers that exist.)
    for (const kind of ["meta_ads", "google_ads", "tiktok_ads", "quickbooks", "easypost_ship"]) {
      expect(isConnectable(kind) && isApiKeyConnect(kind)).toBe(false);
    }
  });

  it("surfaces a post-connect success notice for EasyPost (same channel as OAuth)", () => {
    expect(connectionNotice(new URLSearchParams("easypost=connected"))).toEqual({
      key: "easypost",
      provider: "EasyPost",
      ok: true,
      reason: undefined,
    });
  });
});
