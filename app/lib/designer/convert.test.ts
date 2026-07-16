import { describe, expect, it } from "vitest";
import { closeProductLoops } from "./convert.server";

describe("closeProductLoops", () => {
  it("closes the loop after the repeated element's own close tag", () => {
    const html = '{{#products}}<article data-designer-repeat="article" class="card"><h3>{{product.title}}</h3></article><footer>after</footer>';
    expect(closeProductLoops(html)).toBe(
      '{{#products}}<article class="card"><h3>{{product.title}}</h3></article>{{/products}}<footer>after</footer>',
    );
  });

  it("handles nested same-tag elements inside the repeat", () => {
    const html = '{{#products}}<div data-designer-repeat="div"><div class="inner"><div>deep</div></div></div><p>after</p>';
    expect(closeProductLoops(html)).toBe(
      '{{#products}}<div><div class="inner"><div>deep</div></div></div>{{/products}}<p>after</p>',
    );
  });

  it("closes multiple independent loops", () => {
    const html =
      '{{#products}}<li data-designer-repeat="li">a</li><hr>{{#products}}<li data-designer-repeat="li">b</li>';
    expect(closeProductLoops(html)).toBe("{{#products}}<li>a</li>{{/products}}<hr>{{#products}}<li>b</li>{{/products}}");
  });

  it("leaves markup without repeat markers untouched", () => {
    const html = "<section><h2>Static</h2></section>";
    expect(closeProductLoops(html)).toBe(html);
  });

  it("does not confuse a longer tag name sharing the prefix", () => {
    const html = '{{#products}}<a data-designer-repeat="a"><abbr>x</abbr></a><span>after</span>';
    expect(closeProductLoops(html)).toBe("{{#products}}<a><abbr>x</abbr></a>{{/products}}<span>after</span>");
  });
});
