// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AssistantPanel from "../AssistantPanel";
import type { DashboardCtx } from "../context";

const clientMocks = vi.hoisted(() => ({
  fetchAssistantHistory: vi.fn(),
  sendAssistantMessage: vi.fn(),
}));

vi.mock("~/lib/dashboard/client", () => ({
  ...clientMocks,
  AssistantSendError: class AssistantSendError extends Error {
    conversationId = null;
  },
}));

describe("AssistantPanel product-tour demo", () => {
  let host: HTMLDivElement;
  let root: Root;
  const app = {
    nav: { screen: "dashboard" },
  } as unknown as DashboardCtx;

  beforeEach(() => {
    HTMLElement.prototype.scrollTo = vi.fn();
    clientMocks.fetchAssistantHistory.mockReset();
    clientMocks.sendAssistantMessage.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("uses the real panel UI for a local example without calling the assistant API", async () => {
    act(() => root.render(<AssistantPanel app={app} tourDemo={{ n: 1 }} />));

    await vi.waitFor(
      () => {
        expect(host.querySelector('[role="dialog"][aria-label="Ask Calderyn"]')).not.toBeNull();
        expect(host.textContent).toContain("What should I reorder this week?");
        expect(host.textContent).toContain("Linen Shirt is first");
      },
      { timeout: 2_000 },
    );

    expect(clientMocks.fetchAssistantHistory).not.toHaveBeenCalled();
    expect(clientMocks.sendAssistantMessage).not.toHaveBeenCalled();
  });
});
