import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as PersistModule from "~/lib/assets/persist.server";
import type { CreativeInput, Variant } from "../types";
import { saveVariants } from "../runs.server";

const { holder, persistMock } = vi.hoisted(() => ({
  holder: { variants: undefined as Variant[] | undefined },
  persistMock: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  resolveShopId: async (s: string) => s,
  getSupabase: () => ({
    from: () => ({
      update: (payload: { variants: Variant[] }) => {
        holder.variants = payload.variants;
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { id: "run1", created_at: "t", variants: payload.variants }, error: null }),
              }),
            }),
          }),
        };
      },
    }),
  }),
}));

// Keep the real isFetchableUrl (pure); mock only the network-touching persist.
vi.mock("~/lib/assets/persist.server", async (importActual) => {
  const actual = await importActual<typeof PersistModule>();
  return { ...actual, persistExternalImage: persistMock };
});

const SHOP = "11111111-1111-1111-1111-111111111111";

function input(imageUrl: string | null): CreativeInput {
  return { imageUrl, mediaKind: "image", videoFrameUrls: [], videoDurationSec: null, headline: "h", primaryText: "p", cta: "SHOP_NOW", destinationUrl: "https://shop.test/x", audience: "a" };
}
function variant(mode: "image" | "copy", imageUrl: string | null): Variant {
  return { mode, input: input(imageUrl), rationale: "r", composite: 80, delta: 5, summary: "s" };
}

beforeEach(() => {
  holder.variants = undefined;
  persistMock.mockReset().mockResolvedValue({ persisted: true, url: "https://owned.cdn/a.png", assetId: "a1", storageKey: "k" });
});

describe("saveVariants image persistence", () => {
  it("captures image-mode generated URLs into owned storage and rewrites them; leaves copy-mode + data: URLs alone", async () => {
    const variants = [
      variant("image", "https://higgs.cdn/gen.png"),
      variant("copy", "https://scontent.meta/orig.jpg"),
      variant("image", "data:image/png;base64,AAAA"),
    ];
    await saveVariants(SHOP, "run1", variants);

    // Only the fetchable image-mode variant is persisted.
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith(SHOP, "https://higgs.cdn/gen.png", "generated", "generated");

    const saved = holder.variants!;
    expect(saved[0].input.imageUrl).toBe("https://owned.cdn/a.png"); // rewritten to owned
    expect(saved[1].input.imageUrl).toBe("https://scontent.meta/orig.jpg"); // copy-mode untouched
    expect(saved[2].input.imageUrl).toBe("data:image/png;base64,AAAA"); // non-fetchable untouched
  });

  it("keeps the ephemeral url when persistence fails (rule 12)", async () => {
    persistMock.mockResolvedValue({ persisted: false, url: "https://higgs.cdn/gen.png", error: "fetch_failed" });
    await saveVariants(SHOP, "run1", [variant("image", "https://higgs.cdn/gen.png")]);
    expect(holder.variants![0].input.imageUrl).toBe("https://higgs.cdn/gen.png");
  });
});
