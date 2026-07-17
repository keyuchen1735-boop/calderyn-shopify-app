import { existsSync } from "node:fs";
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
});
