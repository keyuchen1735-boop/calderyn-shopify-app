import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TopBar from "../TopBar";

vi.mock("@gsap/react", () => ({ useGSAP: () => undefined }));

describe("Store top bar", () => {
  it("keeps preview and publish controls without legacy experiment actions", () => {
    const markup = renderToStaticMarkup(createElement(TopBar, {
      storefrontUrl: "/storefront",
      onOpenStorefront: () => undefined,
      hasPublished: false,
      building: false,
      page: "home",
      onPageChange: () => undefined,
      device: "desktop",
      onDeviceChange: () => undefined,
      onPublish: () => undefined,
      publishing: false,
      canPublish: true,
    }));
    expect(markup).toContain("Publish");
    expect(markup).not.toContain("Mark up");
    expect(markup).not.toMatch(/Testing|Ship|Stop early|experiment/i);
  });
});
