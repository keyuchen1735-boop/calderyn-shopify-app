// @vitest-environment jsdom
// The header status pill reports what the store actually has — a status edit
// that fails to save (422 incomplete_shipping when activating without
// shipping dimensions) must leave the pill on the persisted status, never
// claiming the product went live.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductEditor from "../ProductEditor";
import { DashboardApiError } from "~/lib/dashboard/client";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { fetchProduct, fetchCollections, saveProduct } = vi.hoisted(() => ({
  fetchProduct: vi.fn(),
  fetchCollections: vi.fn(),
  saveProduct: vi.fn(),
}));

vi.mock("../../hero/hero-motion", () => ({ reduced: () => true }));
vi.mock("../InventoryPanel", () => ({ default: () => null }));
vi.mock("../NewProductFlow", () => ({ default: () => null }));
vi.mock("~/lib/dashboard/client", () => ({
  DashboardApiError: class DashboardApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
  fetchProduct,
  fetchCollections,
  saveProduct,
  uploadProductImage: vi.fn(),
  setPrimaryProductImage: vi.fn(),
  moveProductImage: vi.fn(),
  setProductImageAlt: vi.fn(),
  deleteProductImage: vi.fn(),
  archiveProduct: vi.fn(),
}));

const PRODUCT = {
  id: "p1",
  title: "Soy Candle",
  status: "draft" as const,
  handle: "soy-candle",
  vendor: "",
  category: null,
  description: "",
  tags: [],
  options: [],
  variants: [{ optionValues: [] }],
  collectionIds: [],
  media: [],
  updatedAt: "2026-07-20T00:00:00Z",
  seoListing: null,
};

function dashboardApp() {
  return {
    nav: { screen: "product-editor", param: "p1" },
    toast: vi.fn(),
    navigate: vi.fn(),
    storeLabel: "Store",
    orgSlug: "store",
  };
}

async function renderEditor(app = dashboardApp()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ProductEditor app={app as never} />);
    await Promise.resolve();
  });
  return { app, host, root };
}

function pillText(host: HTMLElement): string | null {
  const pill = host.querySelector(".cd-screen-head .cd-badge");
  return pill?.textContent ?? null;
}

function setStatusSelect(host: HTMLElement, value: string) {
  const select = [...host.querySelectorAll<HTMLSelectElement>("select.cd-input")].find((s) =>
    [...s.options].some((o) => o.value === "active"),
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return select;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProduct.mockResolvedValue(structuredClone(PRODUCT));
  fetchCollections.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ProductEditor status pill", () => {
  it("keeps the prior status on the pill when activating fails with a 422", async () => {
    saveProduct.mockRejectedValue(
      new DashboardApiError(422, "incomplete_shipping", "incomplete_shipping"),
    );
    const { app, host } = await renderEditor();
    expect(pillText(host)).toBe("Draft");

    const select = setStatusSelect(host, "active");
    // The edit itself is optimistic in the form control…
    expect(select.value).toBe("active");
    // …but the pill only reports the persisted status.
    expect(pillText(host)).toBe("Draft");

    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Save",
    )!;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(saveProduct).toHaveBeenCalledTimes(1);
    expect(app.toast).toHaveBeenCalledWith(
      "Add size and weight before this product can go live.",
      "warn",
      "critical",
    );
    // Failed save: the pill still shows what the store has.
    expect(pillText(host)).toBe("Draft");
    // The merchant's intent isn't clobbered — they can add shipping and retry.
    expect(select.value).toBe("active");
  });

  it("moves the pill only after a successful save", async () => {
    saveProduct.mockResolvedValue({ id: "p1" });
    const { host } = await renderEditor();
    setStatusSelect(host, "active");
    expect(pillText(host)).toBe("Draft");

    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Save",
    )!;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(pillText(host)).toBe("Active");
  });
});
