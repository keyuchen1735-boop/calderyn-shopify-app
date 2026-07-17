// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Store from "./Store";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { StoreCommandEvent } from "~/lib/storefront-command/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { fetchImportStatus, fetchStore, sendStoreCommand, uploadCampaignCreativeImage } = vi.hoisted(() => ({
  fetchImportStatus: vi.fn(),
  fetchStore: vi.fn(),
  sendStoreCommand: vi.fn(),
  uploadCampaignCreativeImage: vi.fn(),
}));

vi.mock("@gsap/react", () => ({ useGSAP: () => undefined }));
vi.mock("gsap", () => ({ default: { registerPlugin: vi.fn(), from: vi.fn() } }));
vi.mock("../hero/hero-motion", () => ({ reduced: () => true }));
vi.mock("~/lib/dashboard/screen-cache", () => ({
  SCREEN_CACHE_KEYS: { storeStudio: "store" },
  cachedScreenData: () => undefined,
  cacheScreenData: vi.fn(),
}));
vi.mock("~/lib/dashboard/client", () => ({
  DashboardApiError: class DashboardApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  fetchImportStatus,
  saveProduct: vi.fn(),
  uploadCampaignCreativeImage,
  IMPORT_IN_PROGRESS: new Set(["pulling", "promoting"]),
}));
vi.mock("~/lib/dashboard/store-client", () => ({
  fetchStore,
  sendStoreCommand,
}));

const VERSION = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const TARGET = "55555555-5555-5555-5555-555555555555";
const SNAPSHOT = {
  settings: { storeName: "Store", accent: "#112233", vibe: "minimal", logoUrl: null, tagline: null },
  hero: null,
  products: [],
  productCount: 1,
  draftProductCount: 0,
  checkoutReady: true,
  hasDraft: true,
  hasPublished: false,
  release: { draftVersionId: VERSION, publishedVersionId: null, draftRuntime: 1, publishedRuntime: 0 },
  generation: null,
  orgSlug: "store",
  storefrontUrl: "/storefront",
  experiment: null,
  sections: [],
  policies: [],
};

function dashboardApp() {
  return {
    shopDomain: null,
    authBase: undefined,
    toast: vi.fn(),
    navigate: vi.fn(),
  };
}

async function renderStore(app = dashboardApp()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Store app={app as never} />);
    await Promise.resolve();
  });
  return { app, host, root };
}

function typePrompt(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Tell Calderyn what to change"]')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function sendPrompt(host: HTMLElement, value: string) {
  typePrompt(host, value);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchStore.mockResolvedValue(structuredClone(SNAPSHOT));
  fetchImportStatus.mockResolvedValue(null);
  uploadCampaignCreativeImage.mockResolvedValue({
    id: "asset-reference",
    url: "https://assets.example/reference.webp",
    assetRef: "11111111-1111-4111-8111-111111111111/upload/reference.webp",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Store command orchestration", () => {
  it("maps page selections to runtime preview routes", async () => {
    const { host, root } = await renderStore();
    const initialFrame = host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]');
    const previewParams = () => new URL(host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')!.src)
      .searchParams;

    expect(Object.fromEntries(previewParams())).toMatchObject({ route: "home", page: "home" });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Home page"))!.click();
    });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Product page"))!.click();
    });
    expect(Object.fromEntries(previewParams())).toMatchObject({ route: "product", page: "pdp" });
    expect(host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')).not.toBe(initialFrame);

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Product page"))!.click();
    });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Collection"))!.click();
    });
    expect(Object.fromEntries(previewParams())).toMatchObject({ route: "collection", page: "collection" });
    act(() => root.unmount());
  });

  it("does not expose disconnected preview markup controls", async () => {
    const { host, root } = await renderStore();
    expect(host.textContent).not.toContain("Mark up");
    expect(host.querySelector(".cd-mark-layer")).toBeNull();
    expect(host.querySelector(".cd-mark-capture")).toBeNull();
    expect(host.querySelector(".cd-mark-note")).toBeNull();
    act(() => root.unmount());
  });

  it("sends a fresh prompt with an explicit null draft pointer", async () => {
    fetchStore.mockResolvedValue({
      ...structuredClone(SNAPSHOT),
      hasDraft: false,
      release: { ...SNAPSHOT.release, draftVersionId: null, draftRuntime: 0 },
    });
    sendStoreCommand.mockResolvedValue({ status: "unchanged", message: "Nothing changed." });
    const { host, root } = await renderStore();
    await sendPrompt(host, "Build a warm shop");
    expect(sendStoreCommand.mock.calls[0]?.[0]).toEqual({
      kind: "prompt",
      prompt: "Build a warm shop",
      expectedDraftVersionId: null,
    });
    expect(host.querySelector(".cd-welcome")?.textContent).toContain("Nothing changed.");
    act(() => root.unmount());
  });

  it("sends owned design-reference and fragment-shader attachments with the prompt command", async () => {
    sendStoreCommand.mockResolvedValue({ status: "unchanged", message: "Nothing changed." });
    const { host, root } = await renderStore();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Attach a design reference or shader"]');
    expect(input).not.toBeNull();
    if (!input) return;
    const image = new File(["image"], "reference.webp", { type: "image/webp" });
    const shader = new File(["shader"], "effect.frag", { type: "text/plain" });
    const source = "void main(){gl_FragColor=vec4(1.);}";
    Object.defineProperty(shader, "text", { value: vi.fn().mockResolvedValue(source) });
    Object.defineProperty(input, "files", { configurable: true, value: [image, shader] });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await sendPrompt(host, "Use these references");

    expect(uploadCampaignCreativeImage).toHaveBeenCalledWith(image);
    expect(sendStoreCommand.mock.calls[0]?.[0]).toEqual({
      kind: "prompt",
      prompt: "Use these references",
      expectedDraftVersionId: VERSION,
      attachments: [
        { kind: "design_reference", assetRef: "11111111-1111-4111-8111-111111111111/upload/reference.webp" },
        { kind: "fragment_shader", source },
      ],
    });
    act(() => root.unmount());
  });

  it("keeps each successful upload staged when a later attachment fails", async () => {
    sendStoreCommand.mockResolvedValue({ status: "unchanged", message: "Nothing changed." });
    uploadCampaignCreativeImage
      .mockReset()
      .mockResolvedValueOnce({
        id: "asset-good",
        url: "https://assets.example/good.webp",
        assetRef: "11111111-1111-4111-8111-111111111111/good.webp",
      })
      .mockRejectedValueOnce(new DashboardApiError(415, "unsupported_type", "That image is not supported."));
    const { host, root } = await renderStore();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Attach a design reference or shader"]')!;
    const good = new File(["good"], "good.webp", { type: "image/webp" });
    const bad = new File(["bad"], "bad.webp", { type: "image/webp" });
    Object.defineProperty(input, "files", { configurable: true, value: [good, bad] });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector(".cd-composer-chip")?.textContent).toContain("good.webp");
    await sendPrompt(host, "Use the successful reference");
    expect(sendStoreCommand.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{
        kind: "design_reference",
        assetRef: "11111111-1111-4111-8111-111111111111/good.webp",
      }],
    });
    act(() => root.unmount());
  });

  it("stages at most four design-reference images", async () => {
    sendStoreCommand.mockResolvedValue({ status: "unchanged", message: "Nothing changed." });
    uploadCampaignCreativeImage.mockReset().mockImplementation(async (file: File) => ({
      id: file.name,
      url: `https://assets.example/${file.name}`,
      assetRef: `11111111-1111-4111-8111-111111111111/${file.name}`,
    }));
    const { host, root } = await renderStore();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Attach a design reference or shader"]')!;
    const images = Array.from({ length: 5 }, (_, index) =>
      new File([String(index)], `reference-${index}.webp`, { type: "image/webp" }));
    Object.defineProperty(input, "files", { configurable: true, value: images });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(uploadCampaignCreativeImage).toHaveBeenCalledTimes(4);
    expect(host.querySelectorAll(".cd-composer-chip")).toHaveLength(4);
    await sendPrompt(host, "Use these references");
    const command = sendStoreCommand.mock.calls[0]?.[0] as { attachments?: unknown[] };
    expect(command.attachments).toHaveLength(4);
    act(() => root.unmount());
  });

  it("uses the server's UTF-16 shader cap before staging an attachment", async () => {
    const app = dashboardApp();
    const { host, root } = await renderStore(app);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Attach a design reference or shader"]')!;
    const shader = new File(["shader"], "effect.frag", { type: "text/plain" });
    const source = `/*${"😀".repeat(2_000)}*/\nvoid main(){}`;
    expect(Array.from(source)).toHaveLength(2_018);
    expect(source.length).toBe(4_018);
    Object.defineProperty(shader, "text", { value: vi.fn().mockResolvedValue(source) });
    Object.defineProperty(input, "files", { configurable: true, value: [shader] });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector(".cd-composer-chip")).toBeNull();
    expect(app.toast).toHaveBeenCalledWith(
      '"effect.frag" must contain a shader of 4,000 characters or fewer.',
      "warn",
    );
    act(() => root.unmount());
  });

  it.each([
    ["network failure", new DashboardApiError(0, "storefront_command_network_error", "Offline")],
    ["draft conflict", new DashboardApiError(409, "storefront_command_conflict", "Refresh and try again")],
    ["cancellation", new DOMException("Stopped", "AbortError")],
  ])("restores the exact staged attachments after %s", async (_label, error) => {
    sendStoreCommand
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ status: "unchanged", message: "Nothing changed." });
    const { host, root } = await renderStore();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Attach a design reference or shader"]')!;
    const image = new File(["image"], "reference.webp", { type: "image/webp" });
    const shader = new File(["shader"], "effect.frag", { type: "text/plain" });
    const source = "void main(){gl_FragColor=vec4(1.);}";
    Object.defineProperty(shader, "text", { value: vi.fn().mockResolvedValue(source) });
    Object.defineProperty(input, "files", { configurable: true, value: [image, shader] });

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await sendPrompt(host, "Use this reference");

    expect([...host.querySelectorAll(".cd-composer-chip")].map(({ textContent }) => textContent))
      .toEqual(["reference.webp", "effect.frag"]);
    expect(host.querySelector<HTMLImageElement>(".cd-composer-chip img")?.src)
      .toBe("https://assets.example/reference.webp");

    await sendPrompt(host, "Retry this reference");
    expect(sendStoreCommand.mock.calls[1]?.[0]).toMatchObject({
      attachments: [{
        kind: "design_reference",
        assetRef: "11111111-1111-4111-8111-111111111111/upload/reference.webp",
      }, { kind: "fragment_shader", source }],
    });
    expect(host.querySelector(".cd-composer-chip")).toBeNull();
    act(() => root.unmount());
  });

  it("shows the user message before work and uses the current draft pointer", async () => {
    let finish: (value: unknown) => void = () => {};
    sendStoreCommand.mockImplementationOnce((_command, onEvent: (event: StoreCommandEvent) => void) => new Promise((resolve) => {
      onEvent({ stage: "understanding" });
      finish = resolve;
    }));
    const { host, root } = await renderStore();
    typePrompt(host, "Make it warmer");
    const send = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    await act(async () => send.click());

    expect(sendStoreCommand).toHaveBeenCalledWith(
      { kind: "prompt", prompt: "Make it warmer", expectedDraftVersionId: VERSION },
      expect.any(Function),
      expect.any(AbortSignal),
    );
    const bubbles = [...host.querySelectorAll(".cd-thread > *")];
    expect(bubbles[0]?.textContent).toContain("Make it warmer");
    expect(bubbles[1]?.textContent).toMatch(/understand|request/i);

    await act(async () => finish({ status: "unchanged", message: "Nothing changed." }));
    act(() => root.unmount());
  });

  it("ignores internal command frames and maps only merchant-facing stages", async () => {
    let finish: (value: unknown) => void = () => {};
    sendStoreCommand.mockImplementationOnce((_command, onEvent: (event: StoreCommandEvent) => void) => new Promise((resolve) => {
      onEvent({ stage: "compiling" } as never);
      onEvent({ stage: "checking_preview" });
      finish = resolve;
    }));
    const { host, root } = await renderStore();
    await sendPrompt(host, "Tighten the layout");
    expect(host.textContent).not.toMatch(/compiling/i);
    expect(host.textContent).toMatch(/checking your preview/i);
    await act(async () => finish({ status: "unchanged", message: "Nothing changed." }));
    act(() => root.unmount());
  });

  it("keeps an installed receipt optimistic when the follow-up snapshot refresh fails", async () => {
    const app = dashboardApp();
    fetchStore.mockResolvedValueOnce(structuredClone(SNAPSHOT)).mockRejectedValueOnce(new Error("refresh failed"));
    sendStoreCommand.mockResolvedValue({ status: "installed", versionId: RESULT, undo: null });
    const { host, root } = await renderStore(app);
    await sendPrompt(host, "Make it warmer");
    expect(host.textContent).toContain("Done. The change is in your preview.");
    expect(host.textContent).not.toMatch(/try again|could not be completed/i);
    expect(host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')?.src).toContain("v=1");
    expect(app.toast).toHaveBeenCalledWith(
      "The preview changed, but the latest store details could not be refreshed.",
      "warn",
    );
    act(() => root.unmount());
  });

  it("does not reload or install when the command is unchanged", async () => {
    sendStoreCommand.mockResolvedValue({ status: "unchanged", message: "Already matches." });
    const { host, root } = await renderStore();
    await sendPrompt(host, "Keep it as-is");
    expect(host.textContent).toContain("Already matches.");
    expect(fetchStore).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')?.src).toContain("v=0");
    act(() => root.unmount());
  });

  it("publishes the latest optimistic draft pointer", async () => {
    fetchStore.mockResolvedValueOnce(structuredClone(SNAPSHOT)).mockRejectedValueOnce(new Error("refresh failed"));
    sendStoreCommand
      .mockResolvedValueOnce({ status: "installed", versionId: RESULT, undo: null })
      .mockResolvedValueOnce({ status: "unchanged", message: "Publish checked." });
    const { host, root } = await renderStore();
    await sendPrompt(host, "Make it warmer");
    const publish = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Publish")!;
    await act(async () => publish.click());
    expect(sendStoreCommand.mock.calls[1]?.[0]).toEqual({
      kind: "publish",
      expectedDraftVersionId: RESULT,
    });
    act(() => root.unmount());
  });

  it("refreshes the snapshot and preview after a command conflict", async () => {
    fetchStore
      .mockResolvedValueOnce(structuredClone(SNAPSHOT))
      .mockResolvedValueOnce({
        ...structuredClone(SNAPSHOT),
        release: { ...SNAPSHOT.release, draftVersionId: RESULT },
      });
    sendStoreCommand.mockRejectedValue(new DashboardApiError(409, "storefront_command_conflict", "Store changed elsewhere."));
    const { host, root } = await renderStore();
    await sendPrompt(host, "Make it warmer");
    expect(fetchStore).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Store changed elsewhere.");
    expect(host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')?.src).toContain("v=1");
    act(() => root.unmount());
  });

  it("reconciles an aborted command without claiming whether its terminal write committed", async () => {
    fetchStore
      .mockResolvedValueOnce(structuredClone(SNAPSHOT))
      .mockResolvedValueOnce({
        ...structuredClone(SNAPSHOT),
        release: { ...SNAPSHOT.release, draftVersionId: RESULT },
      });
    sendStoreCommand.mockRejectedValue(new DOMException("Stopped", "AbortError"));
    const { host, root } = await renderStore();
    await sendPrompt(host, "Make it warmer");
    expect(host.textContent).toContain("Check the preview before sending another change.");
    expect(host.textContent).not.toContain("was not changed");
    expect(fetchStore).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("uses the returned CAS pair for Undo and the installed pointer for the next command", async () => {
    sendStoreCommand.mockImplementation(async (command, onEvent: (event: StoreCommandEvent) => void) => {
      if (command.kind === "prompt") {
        const receipt = {
          status: "installed" as const,
          versionId: RESULT,
          undo: { targetVersionId: TARGET, expectedDraftVersionId: RESULT },
        };
        onEvent({ stage: "ready", receipt });
        return receipt;
      }
      const receipt = { status: "installed" as const, versionId: TARGET, undo: null };
      onEvent({ stage: "ready", receipt });
      return receipt;
    });
    const { host, root } = await renderStore();
    typePrompt(host, "Make it warmer");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
    const undo = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Undo")!;
    await act(async () => undo.click());
    expect(sendStoreCommand.mock.calls[1]?.[0]).toEqual({
      kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: RESULT,
    });
    act(() => root.unmount());
  });
});
