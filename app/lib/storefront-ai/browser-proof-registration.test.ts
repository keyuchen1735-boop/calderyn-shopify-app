import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGenerateDependencies, registerStorefrontAiBrowserProof } from "./generate.server";

const proof = vi.fn(async () => ({ ok: true, diagnostics: [], screenshots: ["sha256:proof"], browserMs: 9 }));

vi.mock("../storefront-validation/browser.server", () => ({ storefrontAiBrowserProof: proof }));

afterEach(() => {
  registerStorefrontAiBrowserProof(proof)();
  proof.mockClear();
});

describe("production storefront AI browser proof registration", () => {
  it("lazy-registers the Chromium adapter instead of leaving custom generation without a browser gate", async () => {
    const deps = createDefaultGenerateDependencies();
    const input = { bundle: {} as never, context: {} as never, persistedAssets: [] };

    await expect(deps.browserProof(input)).resolves.toMatchObject({ ok: true, browserMs: 9 });
    expect(proof).toHaveBeenCalledWith(input);
  });
});
