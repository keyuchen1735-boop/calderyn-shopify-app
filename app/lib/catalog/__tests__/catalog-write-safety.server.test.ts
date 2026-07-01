// Write-path safety added in the ralph-loop iter-4 pass:
//  - a label repeated across two options must resolve to DISTINCT value ids
//    (the old flat label->id map clobbered one and crashed on a duplicate PK);
//  - product_collection links are filtered to the shop's OWN collections
//    (stale/duplicate/foreign ids dropped, not a 500 or a cross-tenant write);
//  - validateProductInput caps + de-dups at the trust boundary.

import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));

let ov = 0, varc = 0, optc = 0;
const links: Array<{ variant_id: string; option_value_id: string }> = [];
const productCollections: Array<{ product_id: string; collection_id: string }> = [];
let ownedSet = new Set<string>();

function idChain(id: string) {
  return { select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }) };
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      insert: (rows: unknown) => {
        if (table === "product_dim") return idChain("p1");
        if (table === "product_option") return idChain("opt-" + optc++);
        if (table === "product_option_value") return idChain("ov-" + ov++);
        if (table === "variant_dim") return idChain("var-" + varc++);
        if (table === "variant_option_value") { links.push(...(rows as typeof links)); return Promise.resolve({ error: null }); }
        if (table === "product_collection") { productCollections.push(...(rows as typeof productCollections)); return Promise.resolve({ error: null }); }
        return Promise.resolve({ error: null });
      },
      upsert: () => Promise.resolve({ error: null }),
      // collection_dim ownership lookup: return only requested ids that are owned.
      select: () => ({ eq: () => ({ in: (_col: string, ids: string[]) => Promise.resolve({ data: ids.filter((i) => ownedSet.has(i)).map((id) => ({ id })), error: null }) }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));

beforeEach(() => {
  project.mockClear();
  ov = 0; varc = 0; optc = 0;
  links.length = 0; productCollections.length = 0;
  ownedSet = new Set();
});

describe("createProduct option-value links", () => {
  it("resolves a label repeated across two options to DISTINCT value ids", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Tee", status: "active",
      options: [{ name: "Color", values: ["Red"] }, { name: "Trim", values: ["Red"] }],
      variants: [{ sku: "X", optionValues: ["Red", "Red"] }],
    });
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.option_value_id)).size).toBe(2);
  });
});

describe("createProduct collection ownership", () => {
  it("inserts only the shop's own collection ids, dropping foreign/stale ones", async () => {
    ownedSet = new Set(["c-own"]);
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", {
      title: "Tee", status: "active",
      variants: [{ sku: "X" }],
      collectionIds: ["c-own", "c-foreign"],
    });
    expect(productCollections.map((r) => r.collection_id)).toEqual(["c-own"]);
  });
});

describe("validateProductInput caps + dedup", () => {
  it("rejects more than 250 variants", async () => {
    const { validateProductInput } = await import("../validate");
    const variants = Array.from({ length: 251 }, (_, i) => ({ sku: `v${i}` }));
    expect(validateProductInput({ title: "T", status: "active", variants }).ok).toBe(false);
  });

  it("rejects more than 3 options", async () => {
    const { validateProductInput } = await import("../validate");
    const r = validateProductInput({
      title: "T", status: "active", variants: [{ sku: "a" }],
      options: [1, 2, 3, 4].map((n) => ({ name: `O${n}`, values: ["x"] })),
    });
    expect(r.ok).toBe(false);
  });

  it("de-dups values within an option but keeps a label shared across options", async () => {
    const { validateProductInput } = await import("../validate");
    const r = validateProductInput({
      title: "T", status: "draft", variants: [{ sku: "a" }],
      options: [{ name: "Size", values: ["M", "M", "L"] }, { name: "Trim", values: ["M"] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.options?.[0].values).toEqual(["M", "L"]);
      expect(r.value.options?.[1].values).toEqual(["M"]);
    }
  });
});
