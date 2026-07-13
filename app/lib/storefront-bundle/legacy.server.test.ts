import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureLegacyRelease } from "./legacy.server";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));

const SHOP = "11111111-1111-1111-1111-111111111111";
const LEGACY = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: LEGACY, error: null });
});

describe("legacy storefront release capture", () => {
  it("delegates one-time, transactionally consistent capture to the database", async () => {
    await expect(captureLegacyRelease({ shopId: SHOP, actorId: null })).resolves.toBe(LEGACY);
    expect(rpc).toHaveBeenCalledWith("capture_storefront_legacy_release", { p_shop_id: SHOP, p_actor_id: null });
  });

  it("returns the existing immutable capture id on repeated calls", async () => {
    await captureLegacyRelease({ shopId: SHOP });
    await captureLegacyRelease({ shopId: SHOP });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.results.every((result) => result.type === "return")).toBe(true);
  });
});
