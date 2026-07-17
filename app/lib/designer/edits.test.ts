import { describe, expect, it } from "vitest";
import { applyDesignerEdits, parseDesignerReply, relaxedFind } from "./edits";

const block = (file: string, search: string, replace: string) =>
  `FILE: ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe("parseDesignerReply", () => {
  it("separates prose from a single edit block", () => {
    const raw = `I made the headline bolder.\n\n${block("home.html", "<h1>Old</h1>", "<h1>New</h1>")}`;
    const parsed = parseDesignerReply(raw);
    expect(parsed.prose).toBe("I made the headline bolder.");
    expect(parsed.edits).toEqual([{ file: "home.html", search: "<h1>Old</h1>", replace: "<h1>New</h1>" }]);
  });

  it("parses multiple blocks across files and keeps surrounding prose", () => {
    const raw = [
      "Two changes coming up.",
      block("base.css", "--accent:#111", "--accent:#264d3b"),
      "And the hero text.",
      block("home.html", "Shop now", "See the collection"),
    ].join("\n\n");
    const parsed = parseDesignerReply(raw);
    expect(parsed.edits).toHaveLength(2);
    expect(parsed.edits[1]).toEqual({ file: "home.html", search: "Shop now", replace: "See the collection" });
    expect(parsed.prose).toContain("Two changes coming up.");
    expect(parsed.prose).toContain("And the hero text.");
  });

  it("tolerates marker-length drift and code fences", () => {
    const raw = "```\nFILE: home.css\n<<<<<<<<< SEARCH\ncolor: red;\n=========\ncolor: blue;\n>>>>>>>>> REPLACE\n```";
    const parsed = parseDesignerReply(raw);
    expect(parsed.edits).toEqual([{ file: "home.css", search: "color: red;", replace: "color: blue;" }]);
    expect(parsed.prose).toBe("");
  });

  it("captures multi-line search and replace bodies verbatim", () => {
    const search = "<div class=\"hero\">\n  <h1>Title</h1>\n</div>";
    const replace = "<div class=\"hero hero--tall\">\n  <h1>Title</h1>\n  <p>Sub</p>\n</div>";
    const parsed = parseDesignerReply(block("home.html", search, replace));
    expect(parsed.edits[0].search).toBe(search);
    expect(parsed.edits[0].replace).toBe(replace);
  });

  it("returns prose only when there are no blocks", () => {
    const parsed = parseDesignerReply("Nothing to change here.");
    expect(parsed.edits).toEqual([]);
    expect(parsed.prose).toBe("Nothing to change here.");
  });
});

describe("applyDesignerEdits", () => {
  it("applies an exact match once (first occurrence)", () => {
    const result = applyDesignerEdits(
      { "home.html": "<p>a</p><p>a</p>" },
      [{ file: "home.html", search: "<p>a</p>", replace: "<p>b</p>" }],
    );
    expect(result.files["home.html"]).toBe("<p>b</p><p>a</p>");
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);
  });

  it("replaces the whole file on the * sentinel", () => {
    const result = applyDesignerEdits(
      { "home.css": ".old{}" },
      [{ file: "home.css", search: " * ", replace: ".new{}" }],
    );
    expect(result.files["home.css"]).toBe(".new{}");
    expect(result.applied).toBe(1);
  });

  it("falls back to whitespace-relaxed matching when indentation drifts", () => {
    const file = "<div>\n    <h1>Hello</h1>\n    <p>World</p>\n</div>";
    const result = applyDesignerEdits(
      { "home.html": file },
      [{ file: "home.html", search: "<h1>Hello</h1>\n<p>World</p>", replace: "<h2>Hi</h2>" }],
    );
    expect(result.files["home.html"]).toBe("<div>\n<h2>Hi</h2>\n</div>");
    expect(result.applied).toBe(1);
  });

  it("rejects edits whose search is absent and edits to unknown files", () => {
    const result = applyDesignerEdits(
      { "home.html": "<p>hi</p>" },
      [
        { file: "home.html", search: "<p>missing</p>", replace: "x" },
        { file: "product.html", search: "<p>hi</p>", replace: "x" },
      ],
    );
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.files["home.html"]).toBe("<p>hi</p>");
  });

  it("keeps $-patterns in the replacement literal instead of as match references", () => {
    const result = applyDesignerEdits(
      { "home.html": "<p>Old copy</p>" },
      [{ file: "home.html", search: "<p>Old copy</p>", replace: "<p>Sale: $& and $' off</p>" }],
    );
    expect(result.files["home.html"]).toBe("<p>Sale: $& and $' off</p>");
  });

  it("applies later edits on top of earlier ones in the same batch", () => {
    const result = applyDesignerEdits(
      { "home.html": "<h1>One</h1>" },
      [
        { file: "home.html", search: "<h1>One</h1>", replace: "<h1>Two</h1>" },
        { file: "home.html", search: "<h1>Two</h1>", replace: "<h1>Three</h1>" },
      ],
    );
    expect(result.files["home.html"]).toBe("<h1>Three</h1>");
    expect(result.applied).toBe(2);
  });
});

describe("relaxedFind", () => {
  it("matches across blank lines in the haystack", () => {
    const hay = "a\n\n  b\nc";
    const found = relaxedFind(hay, "a\nb");
    expect(found).not.toBeNull();
    expect(hay.slice(found!.start, found!.end)).toBe("a\n\n  b");
  });

  it("returns null for an all-whitespace needle", () => {
    expect(relaxedFind("anything", "  \n  ")).toBeNull();
  });

  it("returns null when lines match only partially", () => {
    expect(relaxedFind("a\nb\nc", "a\nc")).toBeNull();
  });
});

describe("hardening: deletions, truncation, ambiguity, allowlist", () => {
  const block = (file: string, search: string, replace: string) =>
    `FILE: ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

  it("parses a deletion block (empty REPLACE)", () => {
    const raw = `Removed the bar.\nFILE: home.html\n<<<<<<< SEARCH\n<div class="bar">Free shipping</div>\n=======\n>>>>>>> REPLACE`;
    const parsed = parseDesignerReply(raw);
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.edits[0].replace).toBe("");
    expect(parsed.prose).toBe("Removed the bar.");
    const result = applyDesignerEdits({ "home.html": `<p>a</p><div class="bar">Free shipping</div><p>b</p>` }, parsed.edits);
    expect(result.applied).toBe(1);
    expect(result.files["home.html"]).toBe("<p>a</p><p>b</p>");
  });

  it("parses an empty-SEARCH block and applies it only to an empty file", () => {
    const raw = `FILE: home.css\n<<<<<<< SEARCH\n=======\nbody{color:red}\n>>>>>>> REPLACE`;
    const parsed = parseDesignerReply(raw);
    expect(parsed.edits).toHaveLength(1);
    const onEmpty = applyDesignerEdits({ "home.css": "" }, parsed.edits);
    expect(onEmpty.applied).toBe(1);
    expect(onEmpty.files["home.css"]).toBe("body{color:red}");
    const onFull = applyDesignerEdits({ "home.css": "body{color:blue}" }, parsed.edits);
    expect(onFull.applied).toBe(0);
    expect(onFull.rejected).toHaveLength(1);
  });

  it("flags a reply cut off mid-block and keeps the partial markup out of prose", () => {
    const raw = `Here we go.\n${block("home.html", "*", "<section>done</section>")}\nFILE: home.css\n<<<<<<< SEARCH\n*\n=======\n.hero{padding`;
    const parsed = parseDesignerReply(raw);
    expect(parsed.truncated).toBe(true);
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.prose).toBe("Here we go.");
    expect(parsed.prose).not.toContain(".hero{padding");
  });

  it("rejects a whitespace-relaxed match that is ambiguous", () => {
    const hay = `<section id="a">\n  <div>x</div>\n</section>\n<section id="b">\n  <div>x</div>\n</section>`;
    const result = applyDesignerEdits({ "home.html": hay }, [
      { file: "home.html", search: "<div>x</div>\n  </section>", replace: "gone" },
    ]);
    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects edits to files outside the allowlist", () => {
    const files = { "home.html": "a", "cart.html": "b", "base.css": "c" };
    const result = applyDesignerEdits(
      files,
      [
        { file: "cart.html", search: "*", replace: "rewritten" },
        { file: "home.html", search: "a", replace: "A" },
      ],
      new Set(["base.css", "home.html", "home.css"]),
    );
    expect(result.applied).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.files["cart.html"]).toBe("b");
    expect(result.files["home.html"]).toBe("A");
  });

  it("keeps stray block markers out of prose", () => {
    const parsed = parseDesignerReply("Done.\n>>>>>>> REPLACE\n=======");
    expect(parsed.prose).toBe("Done.");
    expect(parsed.edits).toHaveLength(0);
    expect(parsed.truncated).toBe(false);
  });
});
