import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import StorePoliciesEditor from "../StorePoliciesEditor";

describe("StorePoliciesEditor", () => {
  it("renders an accessible sparse policy editor without invented legal copy", () => {
    const html = renderToStaticMarkup(createElement(StorePoliciesEditor, {
      policies: [],
      onSave: async () => undefined,
      onDelete: async () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Privacy");
    expect(html).toContain("Terms");
    expect(html).toContain("Returns");
    expect(html).toContain("Shipping");
    expect(html).toContain('aria-label="Policy title"');
    expect(html).toContain('aria-label="Policy text"');
    expect(html).not.toContain("We use your data");
    expect(html).not.toContain("Delete privacy policy");
  });

  it("loads persisted merchant copy and exposes a clearly labeled delete action", () => {
    const html = renderToStaticMarkup(createElement(StorePoliciesEditor, {
      policies: [{
        id: "privacy",
        title: "How we use data",
        body: "We use order details only to fulfill purchases.",
        updatedAt: "2026-07-14T12:00:00.000Z",
      }],
      onSave: async () => undefined,
      onDelete: async () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain('value="How we use data"');
    expect(html).toContain("We use order details only to fulfill purchases.");
    expect(html).toContain('aria-label="Delete privacy policy"');
  });

  it("is wired into Store so successful saves and deletes refresh state and preview", () => {
    const source = readFileSync("app/components/dashboard/screens/Store.tsx", "utf8");
    expect(source).toContain("<StorePoliciesEditor");
    expect(source).toContain("await saveStudioPolicy(policy);\n    await refresh();\n    reloadPreview();");
    expect(source).toContain("await deleteStudioPolicy(policyId);\n    await refresh();\n    reloadPreview();");
  });
});
