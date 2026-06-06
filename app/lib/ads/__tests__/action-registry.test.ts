import { describe, it, expect, vi } from "vitest";

const { meta, google, tiktok } = vi.hoisted(() => ({
  meta: vi.fn(async () => ({ platform: "meta" })),
  google: vi.fn(async () => ({ platform: "google" })),
  tiktok: vi.fn(async () => null),
}));

vi.mock("../../meta/actions.server", () => ({ metaActionAdapterForShop: meta }));
vi.mock("../../google/actions.server", () => ({ googleActionAdapterForShop: google }));
vi.mock("../../tiktok/actions.server", () => ({ tiktokActionAdapterForShop: tiktok }));

import { actionAdapterForShop } from "../action-registry.server";

describe("actionAdapterForShop", () => {
  it("dispatches to the platform resolver", async () => {
    expect(await actionAdapterForShop("s1", "meta")).toMatchObject({ platform: "meta" });
    expect(meta).toHaveBeenCalledWith("s1");
  });
  it("returns null when the platform has no connection", async () => {
    expect(await actionAdapterForShop("s1", "tiktok")).toBeNull();
  });
});
