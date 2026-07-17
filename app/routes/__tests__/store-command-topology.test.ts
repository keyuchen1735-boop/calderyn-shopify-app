import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UNSAFE_flatRoutes } from "@remix-run/dev";
import { describe, expect, it } from "vitest";

describe("Store command route topology", () => {
  it("exposes no alternate code-generating designer endpoint", () => {
    const manifest = UNSAFE_flatRoutes(resolve(process.cwd(), "app"), ["**/*.server.ts", "**/*.server.tsx"], "routes");
    const files = Object.values(manifest).map(({ file }) => file);

    expect(files).not.toEqual(expect.arrayContaining([
      "routes/dashboard.api.designer.tsx",
      "routes/dashboard.designer.preview.tsx",
    ]));

    for (const relativePath of [
      "app/lib/designer",
      "app/components/storefront/DesignerPublicView.tsx",
      "scripts/dev-designer-build-harness.mjs",
    ]) {
      expect(existsSync(resolve(process.cwd(), relativePath)), relativePath).toBe(false);
    }
  });

  it("keeps internal runtime terminology out of merchant-facing route failures", () => {
    for (const relativePath of [
      "app/routes/dashboard.store.preview.tsx",
      "app/routes/storefront._index.tsx",
      "app/routes/storefront.search.tsx",
      "app/routes/storefront.collections.$handle.tsx",
      "app/routes/storefront.products.$handle.tsx",
      "app/routes/storefront.cart.tsx",
      "app/routes/storefront.checkout.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source.toLowerCase(), relativePath).not.toContain("runtime-1");
    }
  });
});
