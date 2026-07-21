import type { LoaderFunctionArgs } from "@remix-run/node";
import { describe, expect, it } from "vitest";

async function load(template: string) {
  const { loader } = await import("../docs.superpowers.prototypes.storefront-recipes.$template[.]html");
  return loader({
    context: {},
    params: { template },
    request: new Request(`https://preview.example.com/docs/superpowers/prototypes/storefront-recipes/${template}.html`),
  } as LoaderFunctionArgs);
}

describe("storefront recipe prototype resource", () => {
  it.each([
    ["volt", "Volt storefront"],
    ["atelier", "Atelier Fit Laboratory storefront"],
    ["gilt", "Gilt storefront"],
    ["ember", "Ember storefront"],
    ["roast", "Roast storefront"],
    ["fizz", "Fizz storefront"],
    ["forge", "Forge storefront"],
    ["haven", "Haven storefront"],
    ["glow", "Glow storefront"],
  ])("serves the existing %s prototype as HTML", async (template, title) => {
    const response = await load(template);

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain(`<title>${title}</title>`);
  });

  it.each(["unknown", "toString"])("returns 404 for %s outside the review allowlist", async (template) => {
    await expect(load(template)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps internal prototypes off the production deployment", async () => {
    const previous = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      await expect(load("volt")).rejects.toMatchObject({ status: 404 });
    } finally {
      if (previous === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = previous;
    }
  });
});
