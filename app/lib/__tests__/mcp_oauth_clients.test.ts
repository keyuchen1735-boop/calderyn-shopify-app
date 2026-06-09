import { vi, describe, it, expect } from "vitest";
import { buildChain, setSupabaseResponse, getRecorded } from "./_supabase_chain_mock";

// vi.mock is hoisted by Vitest to the top of the file before imports,
// so it intercepts the module before mcp_oauth.server.ts loads it.
vi.mock("../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(),
}));

import { registerClient, getClient } from "../mcp_oauth.server";

describe("registerClient", () => {
  it("inserts a row with a generated client_id and returns DCR response shape", async () => {
    setSupabaseResponse({
      data: {
        client_id: "cal_client_abcdefghijklmnop",
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      },
      error: null,
    });
    const out = await registerClient({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const inserts = getRecorded("insert");
    expect(inserts.length).toBe(1);
    const inserted = inserts[0][0] as { client_id: string };
    expect(inserted.client_id).toMatch(/^cal_client_[a-z2-7]{16}$/);
    expect(out.client_id).toMatch(/^cal_client_/);
    expect(out.token_endpoint_auth_method).toBe("none");
    expect(out.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("rejects non-HTTPS redirect URIs", async () => {
    await expect(
      registerClient({ client_name: "x", redirect_uris: ["http://evil/cb"] }),
    ).rejects.toThrow(/INVALID_REDIRECT_URI/);
  });

  it("rejects empty redirect_uris", async () => {
    await expect(registerClient({ client_name: "x", redirect_uris: [] })).rejects.toThrow(
      /INVALID_REDIRECT_URI/,
    );
  });

  it("caps redirect_uris at 5", async () => {
    const uris = Array.from({ length: 6 }, (_, i) => `https://x.example/cb${i}`);
    await expect(registerClient({ client_name: "x", redirect_uris: uris })).rejects.toThrow(
      /TOO_MANY_REDIRECT_URIS/,
    );
  });

  it("rejects empty client_name", async () => {
    await expect(
      registerClient({ client_name: "", redirect_uris: ["https://x.example/cb"] }),
    ).rejects.toThrow(/INVALID_CLIENT_NAME/);
  });
});

describe("getClient", () => {
  it("returns the row when found", async () => {
    setSupabaseResponse({
      data: {
        client_id: "cal_client_x",
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/cb"],
        token_endpoint_auth_method: "none",
      },
      error: null,
    });
    const row = await getClient("cal_client_x");
    expect(row?.client_id).toBe("cal_client_x");
    const eqCalls = getRecorded("eq");
    expect(eqCalls.some((c) => c[0] === "client_id" && c[1] === "cal_client_x")).toBe(true);
  });

  it("returns null when not found", async () => {
    setSupabaseResponse({ data: null, error: null });
    expect(await getClient("nope")).toBeNull();
  });
});
