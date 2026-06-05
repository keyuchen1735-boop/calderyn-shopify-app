// app/lib/simulator/__tests__/html-to-text.test.ts
import { describe, it, expect } from "vitest";
import { htmlToText } from "../html-to-text";

describe("htmlToText", () => {
  it("strips tags and collapses whitespace", () => {
    const html = "<h1>Hello</h1>\n\n  <p>World <strong>now</strong></p>";
    expect(htmlToText(html)).toBe("Hello World now");
  });

  it("drops script and style content entirely", () => {
    const html = "<style>.a{color:red}</style><p>Keep</p><script>alert(1)</script>";
    expect(htmlToText(html)).toBe("Keep");
  });

  it("decodes common entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &mdash; 50%&nbsp;off</p>")).toBe("Tom & Jerry — 50% off");
  });

  it("truncates to maxLen", () => {
    const out = htmlToText("<p>" + "x".repeat(100) + "</p>", 10);
    expect(out.length).toBe(10);
  });
});
