import { beforeEach, describe, expect, it, vi } from "vitest";
import * as commandServer from "./command.server";

const { eq, from, maybeSingle, select } = vi.hoisted(() => ({
  eq: vi.fn(),
  from: vi.fn(),
  maybeSingle: vi.fn(),
  select: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from }),
}));

const SHOP = "11111111-1111-4111-8111-111111111111";
const OTHER_SHOP = "22222222-2222-4222-8222-222222222222";
const KEY = `${SHOP}/reference.webp`;
const URL = "https://assets.example/reference.webp";

type ReferenceLoader = (
  shopId: string,
  assetRefs: readonly string[],
) => Promise<Array<{ assetKey: string; publicUrl: string; mediaType: string }>>;

function referenceLoader(): ReferenceLoader {
  const loader = (commandServer as unknown as { loadVerifiedDesignReferenceImages?: ReferenceLoader })
    .loadVerifiedDesignReferenceImages;
  expect(loader).toBeTypeOf("function");
  return loader!;
}

beforeEach(() => {
  vi.clearAllMocks();
  const query = { eq, maybeSingle, select };
  eq.mockReturnValue(query);
  select.mockReturnValue(query);
  from.mockReturnValue(query);
});

describe("loadVerifiedDesignReferenceImages", () => {
  it("returns only an exact owned asset row with its verified URL and MIME", async () => {
    maybeSingle.mockResolvedValue({
      data: { shop_id: SHOP, storage_key: KEY, public_url: URL, mime: "image/webp" },
      error: null,
    });

    await expect(referenceLoader()(SHOP, [KEY])).resolves.toEqual([{
      assetKey: KEY,
      publicUrl: URL,
      mediaType: "image/webp",
    }]);
    expect(from).toHaveBeenCalledWith("asset_dim");
    expect(eq).toHaveBeenNthCalledWith(1, "shop_id", SHOP);
    expect(eq).toHaveBeenNthCalledWith(2, "storage_key", KEY);
  });

  it("rejects a fabricated same-shop key that has no asset row", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(referenceLoader()(SHOP, [KEY])).rejects.toMatchObject({
      code: "storefront_command_invalid",
      status: 422,
    });
  });

  it("rejects a row that is not owned by the authenticated shop", async () => {
    maybeSingle.mockResolvedValue({
      data: { shop_id: OTHER_SHOP, storage_key: KEY, public_url: URL, mime: "image/webp" },
      error: null,
    });

    await expect(referenceLoader()(SHOP, [KEY])).rejects.toMatchObject({
      code: "storefront_command_invalid",
      status: 422,
    });
  });

  it("rejects more than four references before querying storage metadata", async () => {
    const keys = Array.from({ length: 5 }, (_, index) => `${SHOP}/reference-${index}.webp`);

    await expect(referenceLoader()(SHOP, keys)).rejects.toMatchObject({
      code: "storefront_command_invalid",
      status: 422,
    });
    expect(from).not.toHaveBeenCalled();
  });
});
