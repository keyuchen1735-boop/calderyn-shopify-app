import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatRail from "../ChatRail";

function render(messages: Parameters<typeof ChatRail>[0]["messages"] = []): string {
  return renderToStaticMarkup(h(ChatRail, {
    messages,
    prompt: "",
    onPromptChange: () => {},
    onSend: () => {},
    onStop: () => {},
    busy: false,
    stoppable: false,
  }));
}

describe("ChatRail", () => {
  it("keeps the composer text-only", () => {
    const html = render();
    expect(html).not.toContain("paperclip");
    expect(html).not.toContain("attachment");
    expect(html).not.toContain("model-picker");
    expect(html).toContain('aria-label="Send"');
  });

  it("renders only merchant-facing command progress", () => {
    const html = render([{ id: 1, kind: "ai-working", phase: { kind: "running", stage: "preparing_products" } }]);
    expect(html).toContain("Understanding your request");
    expect(html).toContain("Preparing your catalog");
    expect(html).toContain("Checking your preview");
    expect(html).not.toMatch(/template|compiler|runtime/i);
  });
});
