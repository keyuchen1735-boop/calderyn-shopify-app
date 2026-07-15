// Staged-attachment chips render in the composer with a thumbnail, the filename
// and a labelled remove control. Static markup only (the repo has no jsdom /
// testing-library, so click behavior is covered by the pure canSendComposer /
// planStagedAttachments unit tests instead).
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatRail from "../ChatRail";

function render(attachments: { id: string; url: string; name: string }[], prompt = ""): string {
  return renderToStaticMarkup(
    h(ChatRail, {
      messages: [],
      prompt,
      onPromptChange: () => {},
      onSend: () => {},
      onStop: () => {},
      busy: false,
      stoppable: false,
      attaching: false,
      onAttachFiles: () => {},
      attachments,
      onRemoveAttachment: () => {},
      model: "sonnet",
      onModelChange: () => {},
    }),
  );
}

describe("ChatRail attachment chips", () => {
  it("renders one chip per staged attachment with its thumbnail and a remove button", () => {
    const markup = render([
      { id: "1", url: "blob:one", name: "red-mug.png" },
      { id: "2", url: "blob:two", name: "board.jpg" },
    ]);
    expect(markup).toContain("cd-composer-chips");
    expect(markup).toContain("red-mug.png");
    expect(markup).toContain("board.jpg");
    expect(markup).toContain('src="blob:one"');
    expect(markup).toContain('aria-label="Remove red-mug.png"');
    expect(markup).toContain('aria-label="Remove board.jpg"');
  });

  it("renders no chip container when nothing is staged", () => {
    expect(render([])).not.toContain("cd-composer-chips");
  });
});

describe("live build progress card", () => {
  it("renders one row per real stage with the current stage running", () => {
    const html = renderToStaticMarkup(
      h(ChatRail, {
        messages: [{ id: 1, kind: "ai-working", phase: { kind: "running", stage: "designing" } }],
        prompt: "",
        onPromptChange: () => {},
        onSend: () => {},
        onStop: () => {},
        busy: true,
        stoppable: true,
        attaching: false,
        onAttachFiles: () => {},
        attachments: [],
        onRemoveAttachment: () => {},
        model: "sonnet",
        onModelChange: () => {},
      }),
    );
    expect(html).toContain("Reading your catalog");
    expect(html).toContain("Designing your pages");
    expect(html).toContain("Verifying links");
    // brand finished, designing running, checking pending
    expect(html).toContain('data-st="done"');
    expect(html).toContain('data-st="run"');
    expect(html).toContain('data-st="wait"');
    expect(html).toContain('aria-label="Stop generation"');
  });
});
