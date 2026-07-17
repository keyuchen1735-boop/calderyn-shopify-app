// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";
import Store from "./Store";
import { clearScreenCache } from "~/lib/dashboard/screen-cache";
import { CUSTOM_BENCH_BUNDLE } from "~/lib/storefront-recipes/custom-bench/bundle";
import { action, loader } from "~/routes/dashboard.api.store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const fakes = vi.hoisted(() => ({
  assembleContext: vi.fn(),
  assertWriteAllowed: vi.fn(),
  browserProof: vi.fn(),
  buildEvidence: vi.fn(),
  classify: vi.fn(),
  createVersion: vi.fn(),
  editDraft: vi.fn(),
  getSupabase: vi.fn(),
  hashArtifact: vi.fn(),
  installDraft: vi.fn(),
  loadRecipe: vi.fn(),
  loadStudioState: vi.fn(),
  publishRelease: vi.fn(),
  rateLimit: vi.fn(),
  requirePublishable: vi.fn(),
  requireSameOrigin: vi.fn(),
  session: vi.fn(),
  undoEdit: vi.fn(),
}));

vi.mock("@gsap/react", () => ({ useGSAP: () => undefined }));
vi.mock("gsap", () => ({
  default: { registerPlugin: vi.fn(), from: vi.fn() },
}));
vi.mock("../hero/hero-motion", () => ({ reduced: () => true }));
vi.mock("~/lib/dashboard/http.server", async (original) => {
  const actual = await original<typeof HttpServer>();
  return {
    ...actual,
    rateLimit: fakes.rateLimit,
    requireSameOrigin: fakes.requireSameOrigin,
  };
});
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: fakes.session,
}));
vi.mock("~/lib/storebuilder/studio.server", () => ({
  loadStudioState: fakes.loadStudioState,
  requirePublishableTenantDomain: fakes.requirePublishable,
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: fakes.getSupabase }));
vi.mock("~/lib/storefront-ai/context.server", () => ({
  assembleStorefrontContextWithReferences: fakes.assembleContext,
}));
vi.mock("~/lib/storefront-bundle/build.server", () => ({
  isStorefrontBundlePublishEnabled: () => true,
  isStorefrontRecipeBuildEnabled: () => true,
  loadStorefrontRecipe: fakes.loadRecipe,
}));
vi.mock("~/lib/storefront-bundle/release.server", () => ({
  assertStorefrontWriteAllowed: fakes.assertWriteAllowed,
  createStorefrontBundleVersion: fakes.createVersion,
  editStorefrontDraft: fakes.editDraft,
  hashStorefrontArtifact: fakes.hashArtifact,
  installStorefrontDraft: fakes.installDraft,
  publishStorefrontRelease: fakes.publishRelease,
  StorefrontReleaseError: class StorefrontReleaseError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("~/lib/storefront-bundle/routing-evidence.server", () => ({
  buildCatalogRoutingEvidence: fakes.buildEvidence,
}));
vi.mock("~/lib/storefront-command/intent.server", () => ({
  classifyStoreIntent: fakes.classify,
}));
vi.mock("~/lib/storefront-edit/undo.server", () => ({
  StorefrontUndoError: class StorefrontUndoError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  undoStorefrontEdit: fakes.undoEdit,
}));
vi.mock("~/lib/storefront-runtime/csp.server", () => ({
  isStorefrontBundleReadEnabled: () => true,
}));
vi.mock("~/lib/storefront-validation/browser.server", () => ({
  storefrontAiBrowserProof: fakes.browserProof,
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const CURRENT = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const RESTORED = "55555555-5555-5555-5555-555555555555";
const HASH = `sha256:${"a".repeat(64)}`;
const RESULT_HASH = `sha256:${"b".repeat(64)}`;
const PROMPT = "Make the headline say Summer starts here";

let currentVersion: string | null = CURRENT;
let publishedVersion: string | null = null;
let currentBundle = structuredClone(CUSTOM_BENCH_BUNDLE);
let pendingBundle = structuredClone(CUSTOM_BENCH_BUNDLE);
let storefrontUrl = "/storefront";

function snapshot() {
  return {
    settings: {
      storeName: "Store",
      accent: "#112233",
      vibe: "minimal" as const,
      logoUrl: null,
      tagline: null,
    },
    hero: null,
    products: [],
    productCount: 1,
    draftProductCount: 0,
    checkoutReady: true,
    hasDraft: currentVersion != null,
    hasPublished: publishedVersion != null,
    release: {
      draftVersionId: currentVersion,
      publishedVersionId: publishedVersion,
      draftRuntime: currentVersion == null ? (0 as const) : (1 as const),
      publishedRuntime: publishedVersion == null ? (0 as const) : (1 as const),
    },
    generation: null,
    orgSlug: "store",
    storefrontUrl,
    experiment: null,
    sections: [],
    policies: [],
  };
}

function supabaseQuery(table: string) {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({
      data:
        table === "storefront_release"
          ? {
              draft_version_id: currentVersion,
              published_version_id: publishedVersion,
            }
          : {
              id: currentVersion,
              artifact_hash: HASH,
              bundle_json: currentBundle,
              resolution_json: {},
              runtime_version: 1,
              status: "validated",
            },
      error: null,
    }),
  };
  return query;
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function typePrompt(host: HTMLElement, value: string): void {
  const input = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Tell Calderyn what to change"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderStore() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <Store
        app={{ shopDomain: null, toast: vi.fn(), navigate: vi.fn() } as never}
      />,
    );
  });
  await waitFor(() =>
    expect(
      host.querySelector('textarea[aria-label="Tell Calderyn what to change"]'),
    ).not.toBeNull(),
  );
  return { host, root };
}

function clickButton(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).not.toBeUndefined();
  act(() => button!.click());
}

function sendPrompt(host: HTMLElement, value = PROMPT): void {
  typePrompt(host, value);
  act(() =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearScreenCache();
  currentVersion = CURRENT;
  publishedVersion = null;
  currentBundle = structuredClone(CUSTOM_BENCH_BUNDLE);
  pendingBundle = structuredClone(CUSTOM_BENCH_BUNDLE);
  storefrontUrl = "/storefront";

  fakes.session.mockResolvedValue({ shopId: SHOP, userId: USER });
  fakes.requireSameOrigin.mockReturnValue(location.origin);
  fakes.rateLimit.mockResolvedValue(true);
  fakes.loadStudioState.mockImplementation(async () => snapshot());
  fakes.getSupabase.mockReturnValue({
    from: (table: string) => supabaseQuery(table),
  });
  fakes.assertWriteAllowed.mockResolvedValue(undefined);
  fakes.requirePublishable.mockResolvedValue(undefined);
  fakes.buildEvidence.mockResolvedValue({
    productTitles: [],
    productTypes: [],
    productTags: [],
    optionNames: [],
    collectionTitles: [],
    fingerprint: "sha256:catalog",
  });
  fakes.assembleContext.mockResolvedValue({
    context: {
      version: 1,
      prompt: PROMPT,
      promptHash: `sha256:${"c".repeat(64)}`,
      referenceImages: [],
      store: { name: "Store", logoAssetKey: null, publicBrandAssetKeys: [] },
      collections: [],
      products: [],
      reusableAssets: [],
      recipeNoveltySignatures: [],
      fingerprint: "sha256:context",
    },
    references: { products: {}, collections: {}, assets: {} },
  });
  fakes.classify.mockImplementation(async (input: { bundle?: unknown }) => input.bundle ? {
    kind: "update_text",
    slot: "heroTitle",
    value: "Summer starts here",
  } : {
    kind: "select_design",
    prompt: PROMPT,
    excludedTemplateIds: [],
  });
  fakes.browserProof.mockResolvedValue({
    ok: true,
    diagnostics: [],
    screenshots: ["proof"],
    browserMs: 1,
  });
  fakes.hashArtifact.mockResolvedValue(RESULT_HASH);
  fakes.createVersion.mockImplementation(
    async (input: { artifact: { bundle: typeof CUSTOM_BENCH_BUNDLE } }) => {
      pendingBundle = structuredClone(input.artifact.bundle);
      return RESULT;
    },
  );
  fakes.editDraft.mockImplementation(async () => {
    currentVersion = RESULT;
    currentBundle = structuredClone(pendingBundle);
    return RESULT;
  });
  fakes.loadRecipe.mockResolvedValue({
    bundle: currentBundle,
    report: { profileVersion: 1, ok: true, diagnostics: [] },
  });
  fakes.installDraft.mockImplementation(async () => {
    currentVersion = RESULT;
    currentBundle = structuredClone(pendingBundle);
    return RESULT;
  });
  fakes.publishRelease.mockImplementation(async () => {
    publishedVersion = currentVersion;
    return currentVersion!;
  });
  fakes.undoEdit.mockImplementation(async () => {
    currentVersion = RESTORED;
    currentBundle = structuredClone(CUSTOM_BENCH_BUNDLE);
    return {
      status: "installed",
      versionId: RESTORED,
      undoneVersionId: RESULT,
    };
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.origin,
      );
      if (url.pathname === "/dashboard/api/import/status") {
        return new Response("null", {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname !== "/dashboard/api/store")
        throw new Error(`Unexpected request: ${url.pathname}`);
      const request = input instanceof Request ? input : new Request(url, init);
      return request.method === "GET"
        ? loader({ request, params: {}, context: {} })
        : action({ request, params: {}, context: {} });
    }),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Store vertical command path", () => {
  it("builds the first draft from the rendered welcome action", async () => {
    currentVersion = null;
    const { host, root } = await renderStore();
    clickButton(host, "Let's build my store");

    await waitFor(() =>
      expect(host.textContent).toContain(
        "Done. The change is in your preview.",
      ),
    );
    expect(fakes.installDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: RESULT,
        expectedDraftVersionId: null,
      }),
    );
    expect(fakes.editDraft).not.toHaveBeenCalled();
    expect(fakes.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Build my store",
        excludedTemplateIds: [],
      }),
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(currentVersion).toBe(RESULT);
    expect(host.querySelector('iframe[title="Store preview"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("streams a follow-up edit from the rendered composer into the refreshed preview", async () => {
    let finishProof: (report: {
      ok: boolean;
      diagnostics: never[];
      screenshots: string[];
      browserMs: number;
    }) => void = () => undefined;
    fakes.browserProof.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProof = resolve;
        }),
    );
    const { host, root } = await renderStore();
    await waitFor(() =>
      expect(
        host.querySelector('iframe[title="Store preview"]'),
      ).not.toBeNull(),
    );
    sendPrompt(host);

    await waitFor(() =>
      expect(host.textContent).toContain("Checking your preview"),
    );
    expect(fakes.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: PROMPT,
        currentTemplateId: "custom-bench",
      }),
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => {
      finishProof({
        ok: true,
        diagnostics: [],
        screenshots: ["proof"],
        browserMs: 1,
      });
    });
    await waitFor(() =>
      expect(host.textContent).toContain(
        "Done. The change is in your preview.",
      ),
    );

    expect(fakes.editDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        baseVersionId: CURRENT,
        resultVersionId: RESULT,
        expectedDraftVersionId: CURRENT,
        prompt: PROMPT,
      }),
    );
    expect(currentVersion).toBe(RESULT);
    expect(JSON.stringify(currentBundle)).toContain("Summer starts here");
    expect(fakes.loadStudioState).toHaveBeenCalledTimes(2);
    expect(
      host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')!
        .src,
    ).toContain("v=1");
    expect(fakes.rateLimit).toHaveBeenCalledWith(
      `storefront-build:${SHOP}`,
      10,
      60_000,
    );
    act(() => root.unmount());
  });

  it("undoes an installed edit from the rendered receipt action", async () => {
    const { host, root } = await renderStore();
    sendPrompt(host);
    await waitFor(() => expect(fakes.editDraft).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(host.textContent).toContain(
        "Done. The change is in your preview.",
      ),
    );

    clickButton(host, "Undo");

    await waitFor(() => expect(fakes.undoEdit).toHaveBeenCalledOnce());
    expect(fakes.undoEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        targetVersionId: CURRENT,
        expectedDraftVersionId: RESULT,
      }),
    );
    await waitFor(() => expect(fakes.loadStudioState).toHaveBeenCalledTimes(3));
    expect(currentVersion).toBe(RESTORED);
    expect(JSON.stringify(currentBundle)).not.toContain("Summer starts here");
    expect(
      host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')!
        .src,
    ).toContain("v=2");
    act(() => root.unmount());
  });

  it("publishes the current draft from the rendered top bar", async () => {
    storefrontUrl = "#published";
    const { host, root } = await renderStore();
    clickButton(host, "Publish");

    await waitFor(() =>
      expect(host.textContent).toContain("Published. Opening your storefront."),
    );
    expect(fakes.publishRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftVersionId: CURRENT,
        expectedPublishedVersionId: null,
      }),
    );
    expect(publishedVersion).toBe(CURRENT);
    await waitFor(() =>
      expect(
        host.querySelector(".cd-store-badge")?.getAttribute("data-state"),
      ).toBe("live"),
    );
    act(() => root.unmount());
  });

  it("leaves the draft untouched when the rendered prompt is unsupported", async () => {
    fakes.classify.mockResolvedValueOnce({
      kind: "unsupported",
      message: "Internal detail",
    });
    const { host, root } = await renderStore();
    const initialPreview = host.querySelector<HTMLIFrameElement>(
      'iframe[title="Store preview"]',
    )!.src;

    sendPrompt(host, "Rebuild this with an unsupported structure");

    await waitFor(() =>
      expect(host.textContent).toContain(
        "I couldn't apply that request safely, so your draft was left unchanged.",
      ),
    );
    expect(fakes.browserProof).not.toHaveBeenCalled();
    expect(fakes.createVersion).not.toHaveBeenCalled();
    expect(fakes.installDraft).not.toHaveBeenCalled();
    expect(fakes.editDraft).not.toHaveBeenCalled();
    expect(currentVersion).toBe(CURRENT);
    expect(
      host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')!
        .src,
    ).toBe(initialPreview);
    act(() => root.unmount());
  });

  it("shows a safe conflict and retains the current preview when the CAS write loses", async () => {
    fakes.editDraft.mockRejectedValueOnce(
      Object.assign(new Error("private stale pointer"), {
        code: "storefront_draft_conflict",
        status: 409,
      }),
    );
    const { host, root } = await renderStore();

    sendPrompt(host);

    await waitFor(() =>
      expect(host.textContent).toContain(
        "The storefront changed before this request. Refresh and try again.",
      ),
    );
    expect(fakes.editDraft).toHaveBeenCalledOnce();
    expect(fakes.installDraft).not.toHaveBeenCalled();
    expect(currentVersion).toBe(CURRENT);
    expect(JSON.stringify(currentBundle)).not.toContain("Summer starts here");
    await waitFor(() => expect(fakes.loadStudioState).toHaveBeenCalledTimes(2));
    expect(
      host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')!
        .src,
    ).toContain("v=1");
    expect(host.textContent).not.toContain("private stale pointer");
    act(() => root.unmount());
  });

  it("stops an in-flight prompt from the rendered composer without installing it", async () => {
    let proofSignal: AbortSignal | undefined;
    fakes.browserProof.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          proofSignal = signal;
          const finish = () =>
            resolve({
              ok: true,
              diagnostics: [],
              screenshots: ["proof"],
              browserMs: 1,
            });
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        }),
    );
    const { host, root } = await renderStore();

    sendPrompt(host);
    await waitFor(() => expect(fakes.browserProof).toHaveBeenCalledOnce());
    act(() =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Stop"]')!
        .click(),
    );

    await waitFor(() =>
      expect(host.textContent).toContain(
        "Stopped. Check the preview before sending another change.",
      ),
    );
    expect(proofSignal?.aborted).toBe(true);
    expect(fakes.createVersion).not.toHaveBeenCalled();
    expect(fakes.installDraft).not.toHaveBeenCalled();
    expect(fakes.editDraft).not.toHaveBeenCalled();
    expect(currentVersion).toBe(CURRENT);
    await waitFor(() => expect(fakes.loadStudioState).toHaveBeenCalledTimes(2));
    expect(
      host.querySelector<HTMLIFrameElement>('iframe[title="Store preview"]')!
        .src,
    ).toContain("v=1");
    act(() => root.unmount());
  });
});
