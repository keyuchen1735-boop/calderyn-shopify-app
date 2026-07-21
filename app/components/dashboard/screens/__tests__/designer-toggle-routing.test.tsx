// @vitest-environment jsdom
// D1 (designer-flagship spec): flipping the sparkle toggle must make the very
// next Store visit — same session, no reload — mount the designer studio, even
// when Store's own designer-state fetch is answered from a snapshot taken
// before the toggle's save committed (the walkthrough F1 race: the classic
// builder mounted and the merchant's first prompt died in its rejection path).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Store from "../Store";
import { clearScreenCache } from "~/lib/dashboard/screen-cache";
import { recordDesignerToggle, resetDesignerToggleIntent } from "~/lib/designer/state";
import type { DesignerStateVM } from "~/lib/designer/client";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { fetchDesignerState, fetchStore, fetchImportStatus } = vi.hoisted(() => ({
  fetchDesignerState: vi.fn(),
  fetchStore: vi.fn(),
  fetchImportStatus: vi.fn(),
}));

// The designer surface itself is exercised by its own tests — here it only
// needs to be identifiable so the engine-routing branch is observable.
vi.mock("../DesignerStudio", () => ({
  default: () => <div data-designer-dock="1" />,
}));
vi.mock("~/lib/designer/client", () => ({ fetchDesignerState }));
// Classic-builder collaborators, stubbed to inert: this test is about which
// engine mounts, not about the classic builder's behavior.
vi.mock("../../store/ChatRail", () => ({ default: () => null }));
vi.mock("../../store/TopBar", () => ({ default: () => null }));
vi.mock("../../store/WelcomeOverlay", () => ({ default: () => null }));
vi.mock("~/lib/dashboard/store-client", () => ({ fetchStore, sendStoreCommand: vi.fn() }));
vi.mock("~/lib/dashboard/client", () => ({
  DashboardApiError: class DashboardApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
    }
  },
  fetchImportStatus,
  IMPORT_IN_PROGRESS: new Set<string>(),
  saveProduct: vi.fn(),
  uploadCampaignCreativeImage: vi.fn(),
}));

const designerState = (enabled: boolean): DesignerStateVM => ({
  enabled,
  ready: false,
  unbuiltRoutes: [],
  chat: [],
});

function dashboardApp() {
  return {
    toast: vi.fn(),
    navigate: vi.fn(),
    nav: { screen: "storefront" },
    shopDomain: null,
    authBase: "",
    orgSlug: "store",
    storeLabel: "Store",
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountStore() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Store app={dashboardApp() as never} />);
    await Promise.resolve();
  });
  return host;
}

const designerMounted = () => host!.querySelector("[data-designer-dock]") != null;

beforeEach(() => {
  vi.clearAllMocks();
  clearScreenCache();
  resetDesignerToggleIntent();
  // The classic builder's own data never resolves — irrelevant to routing.
  fetchStore.mockReturnValue(new Promise(() => {}));
  fetchImportStatus.mockResolvedValue(null);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("Store engine routing (sparkle toggle)", () => {
  it("mounts the classic builder when the designer is off", async () => {
    fetchDesignerState.mockResolvedValue(designerState(false));
    await mountStore();
    expect(designerMounted()).toBe(false);
  });

  it("mounts the designer immediately after a toggle, before the save round-trip resolves", async () => {
    // The switch records intent synchronously; the state fetch is still in
    // flight when the merchant lands on Store.
    recordDesignerToggle(true);
    fetchDesignerState.mockReturnValue(new Promise(() => {}));
    await mountStore();
    expect(designerMounted()).toBe(true);
  });

  it("keeps the designer mounted when a stale state read raced the toggle's save (F1)", async () => {
    recordDesignerToggle(true);
    // Store's own fetch was answered before the toggle's POST committed.
    fetchDesignerState.mockResolvedValue(designerState(false));
    await mountStore();
    await act(async () => {
      await Promise.resolve();
    });
    expect(designerMounted()).toBe(true);
  });

  it("swaps to the designer when the server already agrees", async () => {
    fetchDesignerState.mockResolvedValue(designerState(true));
    await mountStore();
    await act(async () => {
      await Promise.resolve();
    });
    expect(designerMounted()).toBe(true);
  });

  it("returns to the classic builder after a toggle-off", async () => {
    recordDesignerToggle(false);
    fetchDesignerState.mockResolvedValue(designerState(false));
    await mountStore();
    expect(designerMounted()).toBe(false);
  });
});
