// app/lib/storefront/settings.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getStoreSettings, saveStoreSettings, DEFAULT_PALETTE } from "./settings.server";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => fromMock.mockReset());

describe("store settings repo", () => {
  it("returns deterministic defaults for a non-uuid (demo) shop without hitting the DB", async () => {
    const s = await getStoreSettings("demo-shop");
    expect(s.storeName).toBeTruthy();
    expect(s.palette).toEqual(DEFAULT_PALETTE);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("maps a store_settings row into StoreSettings", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { store_name: "Acme", palette: { primary: "#000", background: "#fff", text: "#111" }, logo_url: "/l.png", voice_tagline: "Hi" }, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const s = await getStoreSettings(realShop);
    expect(s.storeName).toBe("Acme");
    expect(s.palette.primary).toBe("#000");
  });

  it("falls back to defaults when the shop has no row", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    const s = await getStoreSettings(realShop);
    expect(s.palette).toEqual(DEFAULT_PALETTE);
  });

  it("brands a settings-less real shop with its display_name, never the demo label", async () => {
    const settingsMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const shopMaybeSingle = vi.fn().mockResolvedValue({ data: { display_name: "MVP Rehearsal Co" }, error: null });
    fromMock.mockImplementation((table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: table === "shops" ? shopMaybeSingle : settingsMaybeSingle }) }),
    }));
    const s = await getStoreSettings(realShop);
    expect(s.storeName).toBe("MVP Rehearsal Co");
  });

  it("saveStoreSettings upserts on shop_id", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await saveStoreSettings(realShop, { storeName: "Acme", palette: DEFAULT_PALETTE, logoUrl: null, voiceTagline: "Hi" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: realShop, store_name: "Acme" }),
      { onConflict: "shop_id" },
    );
  });

  it("passes the vibe through both directions, defaulting reads to minimal", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { store_name: "Acme", palette: DEFAULT_PALETTE, logo_url: null, voice_tagline: null, vibe: "warm" }, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) });
    expect((await getStoreSettings(realShop)).vibe).toBe("warm");
    maybeSingle.mockResolvedValue({ data: { store_name: "Acme", vibe: "not-a-vibe" }, error: null });
    expect((await getStoreSettings(realShop)).vibe).toBe("minimal");
  });

  it("save omits the vibe column when unset so the stored value is untouched", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await saveStoreSettings(realShop, { storeName: "Acme", palette: DEFAULT_PALETTE, logoUrl: null, voiceTagline: null });
    expect(upsert.mock.calls[0][0]).not.toHaveProperty("vibe");
    await saveStoreSettings(realShop, { storeName: "Acme", palette: DEFAULT_PALETTE, logoUrl: null, voiceTagline: null, vibe: "bold" });
    expect(upsert.mock.calls[1][0]).toMatchObject({ vibe: "bold" });
  });
});
