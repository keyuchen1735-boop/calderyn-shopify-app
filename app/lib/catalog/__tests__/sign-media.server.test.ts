// Product images live in a PRIVATE Storage bucket; the dashboard reads them via
// short-lived signed URLs minted server-side. These lock the null pass-through
// and the batch helper used by the product loaders.

import { describe, it, expect, vi } from "vitest";

const createSignedUrl = vi
  .fn()
  .mockResolvedValue({ data: { signedUrl: "https://signed/x" }, error: null });
const createSignedUrls = vi.fn(async (paths: string[]) => ({
  data: paths.map((p) => ({ path: p, signedUrl: "https://signed/x", error: null })),
  error: null,
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ storage: { from: () => ({ createSignedUrl, createSignedUrls }) } }),
}));

describe("signMediaPath", () => {
  it("returns null for a null path (no Storage call)", async () => {
    const { signMediaPath } = await import("../sign-media.server");
    expect(await signMediaPath(null)).toBeNull();
  });

  it("signs a real path", async () => {
    const { signMediaPath } = await import("../sign-media.server");
    expect(await signMediaPath("shop1/p1/x.png")).toBe("https://signed/x");
  });
});

describe("signMediaPaths", () => {
  it("signs many paths in ONE batched call, deduped", async () => {
    createSignedUrls.mockClear();
    const { signMediaPaths } = await import("../sign-media.server");
    const map = await signMediaPaths(["a/b.png", "a/b.png", "c/d.png"]);
    expect(map.get("a/b.png")).toBe("https://signed/x");
    expect(map.size).toBe(2);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith(["a/b.png", "c/d.png"], expect.any(Number));
  });
});
