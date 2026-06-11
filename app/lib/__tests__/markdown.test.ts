import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../markdown";

describe("parseMarkdown blocks", () => {
  it("splits paragraphs on blank lines and joins soft-wrapped lines", () => {
    const blocks = parseMarkdown("first line\nstill first\n\nsecond");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "first line still first" }] },
      { type: "paragraph", children: [{ type: "text", text: "second" }] },
    ]);
  });

  it("parses headings at levels 1-3", () => {
    const blocks = parseMarkdown("# One\n## Two\n### Three");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "heading", "heading"]);
    expect(blocks.map((b) => (b.type === "heading" ? b.level : 0))).toEqual([1, 2, 3]);
  });

  it("treats #### (unsupported depth) as plain paragraph text", () => {
    const blocks = parseMarkdown("#### Four");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "#### Four" }] },
    ]);
  });

  it("groups consecutive dash/star items into one unordered list", () => {
    const blocks = parseMarkdown("- a\n* b\n- c");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "a" }],
          [{ type: "text", text: "b" }],
          [{ type: "text", text: "c" }],
        ],
      },
    ]);
  });

  it("parses ordered lists with . and ) markers", () => {
    const blocks = parseMarkdown("1. first\n2) second");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]],
      },
    ]);
  });

  it("ends a list when a non-item line follows", () => {
    const blocks = parseMarkdown("- a\nplain text");
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
  });

  it("captures fenced code blocks verbatim, including markdown-ish content", () => {
    const blocks = parseMarkdown("```\n**not bold**\n- not a list\n```");
    expect(blocks).toEqual([{ type: "code", text: "**not bold**\n- not a list" }]);
  });

  it("renders an unclosed fence as code instead of dropping it", () => {
    const blocks = parseMarkdown("```\ndangling");
    expect(blocks).toEqual([{ type: "code", text: "dangling" }]);
  });

  it("returns no blocks for empty/whitespace input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\n ")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("parses bold, italic and code spans", () => {
    expect(parseInline("a **b** *c* `d`")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "code", text: "d" },
    ]);
  });

  it("keeps markdown inside code spans literal", () => {
    expect(parseInline("`**x**`")).toEqual([{ type: "code", text: "**x**" }]);
  });

  it("nests italic inside bold", () => {
    expect(parseInline("**a *b* c**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", text: "a " },
          { type: "em", children: [{ type: "text", text: "b" }] },
          { type: "text", text: " c" },
        ],
      },
    ]);
  });

  it("parses http(s) links", () => {
    expect(parseInline("[docs](https://example.com/a)")).toEqual([
      {
        type: "link",
        href: "https://example.com/a",
        children: [{ type: "text", text: "docs" }],
      },
    ]);
  });

  it("leaves non-http(s) link schemes as literal text", () => {
    const nodes = parseInline("[x](javascript:alert(1))");
    expect(nodes.every((n) => n.type === "text" || n.type === "em")).toBe(true);
    expect(nodes.some((n) => n.type === "link")).toBe(false);
  });

  it("passes plain text through untouched", () => {
    expect(parseInline("just words")).toEqual([{ type: "text", text: "just words" }]);
  });

  it("treats unbalanced markers as literal text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", text: "2 * 3 = 6" }]);
    expect(parseInline("**dangling")).toEqual([{ type: "text", text: "**dangling" }]);
  });
});
