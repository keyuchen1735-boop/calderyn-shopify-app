import { describe, it, expect, vi, beforeEach } from "vitest";
import { actionAdapterForShop } from "../action-registry.server";

const { meta, google, tiktok, isShowcaseShop, showcaseActionAdapter } = vi.hoisted(() => ({
  meta: vi.fn(async () => ({ platform: "meta" })),
  google: vi.fn(async () => ({ platform: "google" })),
  tiktok: vi.fn(async () => null),
  isShowcaseShop: vi.fn(async () => false),
  showcaseActionAdapter: vi.fn((platform: string) => ({ platform, showcase: true })),
}));

vi.mock("../../meta/actions.server", () => ({ metaActionAdapterForShop: meta }));
vi.mock("../../google/actions.server", () => ({ googleActionAdapterForShop: google }));
vi.mock("../../tiktok/actions.server", () => ({ tiktokActionAdapterForShop: tiktok }));
vi.mock("../../demo/showcase.server", () => ({ isShowcaseShop, showcaseActionAdapter }));

beforeEach(() => {
  vi.clearAllMocks();
  isShowcaseShop.mockResolvedValue(false);
});

describe("actionAdapterForShop", () => {
  it("dispatches to the platform resolver", async () => {
    expect(await actionAdapterForShop("s1", "meta")).toMatchObject({ platform: "meta" });
    expect(meta).toHaveBeenCalledWith("s1");
  });
  it("returns null when the platform has no connection", async () => {
    expect(await actionAdapterForShop("s1", "tiktok")).toBeNull();
  });
  it("returns the showcase adapter for a demo shop, never touching the platform resolver", async () => {
    isShowcaseShop.mockResolvedValue(true);
    expect(await actionAdapterForShop("demo", "meta")).toMatchObject({ platform: "meta", showcase: true });
    expect(meta).not.toHaveBeenCalled();
  });
});
