import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { action } from "../dashboard.api.assets.upload";

const { persistUploadedImage, rateLimit, requireDashboardSession, requireSameOrigin } = vi.hoisted(() => ({
  persistUploadedImage: vi.fn(),
  rateLimit: vi.fn(),
  requireDashboardSession: vi.fn(),
  requireSameOrigin: vi.fn(),
}));

vi.mock("~/lib/assets/upload.server", () => ({ persistUploadedImage, MAX_UPLOAD_BYTES: 10 * 1024 * 1024 }));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...await importOriginal<typeof HttpServer>(),
  rateLimit,
  requireSameOrigin,
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: vi.fn(), saveStoreSettings: vi.fn() }));

describe("dashboard asset upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "11111111-1111-4111-8111-111111111111" });
    rateLimit.mockResolvedValue(true);
    persistUploadedImage.mockResolvedValue({
      assetId: "22222222-2222-4222-8222-222222222222",
      publicUrl: "https://assets.example/reference.webp",
      storageKey: "11111111-1111-4111-8111-111111111111/upload/reference.webp",
      mime: "image/webp",
    });
  });

  it("returns the already-owned storage key as the design-reference assetRef", async () => {
    const form = new FormData();
    form.set("file", new File(["image"], "reference.webp", { type: "image/webp" }));

    const response = await action({
      request: new Request("https://dashboard.example/dashboard/api/assets/upload", { method: "POST", body: form }),
    } as ActionFunctionArgs);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      url: "https://assets.example/reference.webp",
      assetRef: "11111111-1111-4111-8111-111111111111/upload/reference.webp",
      mime: "image/webp",
    });
  });
});
