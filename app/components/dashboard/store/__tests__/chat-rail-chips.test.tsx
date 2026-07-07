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
      busy: false,
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
