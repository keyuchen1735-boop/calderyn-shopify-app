import { describe, expect, it } from "vitest";
import type { DesignerStoreData } from "./types";
import { renderDesignerBody, renderDesignerDocument, scrubDesignerCss, scrubDesignerHtml } from "./render.server";

const data: DesignerStoreData = {
  storeName: "Peak & Pine",
  tagline: "Built for the long trail",
  logoUrl: null,
  products: [
    { id: "1", handle: "summit-tee", title: "Summit <Tee>", description: "Soft & light", priceCents: 5900, compareAtPriceCents: 7900, available: true, imageUrl: "/img/tee.webp" },
    { id: "2", handle: "crest pack", title: "Crest Pack", description: null, priceCents: null, compareAtPriceCents: null, available: false, imageUrl: null },
  ],
};

describe("scrubDesignerHtml", () => {
  it("strips script-capable tags but keeps their surroundings", () => {
    const out = scrubDesignerHtml('<p>a</p><script>alert(1)</script><iframe src="/x"></iframe><form action="/y"><input></form><p>b</p>');
    expect(out).toBe("<p>a</p>alert(1)<input><p>b</p>");
  });

  it("strips inline event handlers in both quote styles", () => {
    expect(scrubDesignerHtml("<a onclick=\"steal()\" onmouseover='x()' href=\"/ok\">a</a>")).toBe('<a href="/ok">a</a>');
  });

  it("strips javascript: and data:text urls", () => {
    expect(scrubDesignerHtml('<a href="javascript:alert(1)">a</a>')).toBe("<a>a</a>");
    expect(scrubDesignerHtml('<a href=" data:text/html,x">a</a>')).toBe("<a>a</a>");
  });

  it("strips external image sources but keeps same-origin and data urls", () => {
    expect(scrubDesignerHtml('<img src="https://evil.example/x.png">')).toBe("<img>");
    expect(scrubDesignerHtml('<img src="//evil.example/x.png">')).toBe("<img>");
    expect(scrubDesignerHtml('<img src="/storefront-recipes/a/hero.webp">')).toContain("/storefront-recipes/a/hero.webp");
    expect(scrubDesignerHtml('<img src="data:image/svg+xml,ok">')).toContain("data:image/svg+xml,ok");
  });

  it("strips external sources in single-quoted and unquoted forms (img-src https is open)", () => {
    expect(scrubDesignerHtml("<img src='https://evil.example/p.gif'>")).toBe("<img>");
    expect(scrubDesignerHtml("<img src=https://evil.example/p.gif>")).toBe("<img>");
    expect(scrubDesignerHtml('<img srcset="https://evil.example/p.gif 2x">')).toBe("<img>");
    expect(scrubDesignerHtml('<video poster="https://evil.example/p.jpg"></video>')).toBe("<video></video>");
    expect(scrubDesignerHtml('<image xlink:href="https://evil.example/p.svg"/>')).toBe("<image/>");
  });

  it("strips unquoted event handlers", () => {
    expect(scrubDesignerHtml("<a onclick=steal() href=\"/ok\">a</a>")).toBe('<a href="/ok">a</a>');
  });

  it("removes link/meta/base tags entirely", () => {
    expect(scrubDesignerHtml('<link rel="stylesheet" href="https://cdn.example/a.css"><meta http-equiv="refresh" content="0"><base href="https://evil.example/">')).toBe("");
  });
});

describe("scrubDesignerCss", () => {
  it("neutralizes external url() and @import but keeps local urls", () => {
    const out = scrubDesignerCss('@import url("https://evil.example/a.css");.a{background:url(https://evil.example/x.png)}.b{background:url(/storefront-recipes/a/x.webp)}');
    expect(out).not.toContain("evil.example");
    expect(out).toContain("url(/storefront-recipes/a/x.webp)");
  });

  it("disables IE expression()", () => {
    expect(scrubDesignerCss("a{width:expression(alert(1))}")).not.toContain("expression(");
  });
});

describe("renderDesignerDocument", () => {
  it("repeats the products loop and fills product placeholders escaped (body keeps links)", () => {
    const html = "{{#products}}<article><h3>{{product.title}}</h3><span>{{product.price}}</span><img src=\"{{product.image}}\" alt=\"{{product.title}}\"><a href=\"{{product.url}}\">View</a></article>{{/products}}";
    const { bodyHtml } = renderDesignerBody({ html, css: "", data });
    expect(bodyHtml).toContain("Summit &lt;Tee&gt;");
    expect(bodyHtml).toContain("$59.00");
    expect(bodyHtml).toContain('src="/img/tee.webp"');
    expect(bodyHtml).toContain('href="/storefront/products/crest%20pack"');
    expect(bodyHtml).toContain('src="data:image/svg+xml'); // neutral fallback for missing image
    expect((bodyHtml.match(/<article>/g) ?? []).length).toBe(2);
  });

  it("makes the preview document inert: links keep their text but lose navigation", () => {
    const html = '<a href="/storefront/products/x">View</a><button type="button" class="designer-add-to-cart">Add</button>';
    const out = renderDesignerDocument({ html, css: "", data });
    expect(out).toContain(">View</a>");
    expect(out).not.toContain('href="/storefront/products/x"');
    expect(out).toContain("Add"); // buttons still render
  });

  it("fills root placeholders and blanks unknown paths", () => {
    const out = renderDesignerDocument({ html: "<h1>{{store.name}}</h1><p>{{store.tagline}}</p><b>{{bogus.path}}</b>", css: "", data });
    expect(out).toContain("<h1>Peak &amp; Pine</h1>");
    expect(out).toContain("<p>Built for the long trail</p>");
    expect(out).toContain("<b></b>");
  });

  it("previews out-of-loop product placeholders with the first product", () => {
    const out = renderDesignerDocument({
      html: '<h1>{{product.title}}</h1><span>{{product.price}}</span><img src="{{product.image}}">',
      css: "",
      data,
    });
    expect(out).toContain("<h1>Summit &lt;Tee&gt;</h1>");
    expect(out).toContain("<span>$59.00</span>");
    expect(out).toContain('src="/img/tee.webp"');
  });

  it("blanks out-of-loop product placeholders when the catalog is empty", () => {
    const out = renderDesignerDocument({ html: "<i>{{product.title}}</i>", css: "", data: { ...data, products: [] } });
    expect(out).toContain("<i></i>");
  });

  it("escapes single quotes so titles cannot break out of single-quoted attributes", () => {
    const withQuote: DesignerStoreData = {
      ...data,
      products: [{ ...data.products[0], title: "Kids' Pack" }],
    };
    const out = renderDesignerDocument({ html: "{{#products}}<img alt='{{product.title}}'>{{/products}}", css: "", data: withQuote });
    expect(out).toContain("Kids&#39; Pack");
    expect(out).not.toContain("alt='Kids' Pack'");
  });

  it("stamps each looped add-to-cart button with its own product's variant", () => {
    const twoVariants: DesignerStoreData = {
      ...data,
      products: [
        { ...data.products[0], variantId: "var-alpha" },
        { ...data.products[1], variantId: "var-beta" },
      ],
    };
    const html = '{{#products}}<article><button class="designer-add-to-cart" type="button">Add</button></article>{{/products}}';
    const { bodyHtml } = renderDesignerBody({ html, css: "", data: twoVariants });
    expect(bodyHtml).toContain('class="designer-add-to-cart" data-variant-id="var-alpha"');
    expect(bodyHtml).toContain('class="designer-add-to-cart" data-variant-id="var-beta"');
    // Each card carries a distinct variant — not both stamped with the first.
    expect((bodyHtml.match(/data-variant-id="var-alpha"/g) ?? []).length).toBe(1);
  });

  it("respects maxProducts", () => {
    const out = renderDesignerDocument({ html: "{{#products}}<li>{{product.title}}</li>{{/products}}", css: "", data, maxProducts: 1 });
    expect((out.match(/<li>/g) ?? []).length).toBe(1);
  });

  it("scrubs both html and css and blocks style-tag breakout", () => {
    const out = renderDesignerDocument({ html: "<p>ok</p><script>x</script>", css: "a{}</style><script>y</script>", data });
    expect(out).not.toContain("<script>");
    expect(out).toContain("<p>ok</p>");
  });
});
