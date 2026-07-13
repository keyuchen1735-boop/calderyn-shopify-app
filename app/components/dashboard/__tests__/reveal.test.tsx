// @vitest-environment jsdom

import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reveal } from "../ui";

vi.mock("../hero/hero-motion", () => ({ reduced: () => true }));

describe("Reveal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("toggles an accessible, mounted panel and restores focus when closing", () => {
    act(() => {
      root.render(
        <Reveal label="Shipping" summary="Missing weight ⚠" warning>
          <input aria-label="Weight" />
        </Reveal>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>(".cd-reveal-trigger");
    const body = host.querySelector<HTMLElement>(".cd-reveal-body");
    const input = host.querySelector<HTMLInputElement>("input");
    expect(trigger).not.toBeNull();
    expect(body).not.toBeNull();
    expect(input).not.toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(body?.getAttribute("aria-hidden")).toBe("true");
    expect(body?.inert).toBe(true);
    expect(trigger?.getAttribute("aria-controls")).toBe(body?.id);
    expect(host.querySelector(".cd-reveal")?.getAttribute("data-warning")).toBe("1");

    act(() => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(body?.getAttribute("aria-hidden")).toBe("false");
    expect(body?.inert).toBe(false);
    expect(host.querySelector("input")).toBe(input);

    input?.focus();
    expect(document.activeElement).toBe(input);
    act(() => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(body?.inert).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
});
