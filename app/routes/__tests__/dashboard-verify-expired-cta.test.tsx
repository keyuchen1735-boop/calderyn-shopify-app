// The expired-verify screen must never dead-end: /dashboard/verify-needed
// requires a session, so a link opened on another device (no session there)
// has to route through sign-in instead.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));
vi.mock("~/lib/auth/verify.server", () => ({
  consumeVerifyToken: vi.fn(),
  markEmailVerified: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ getSessionFromRequest: vi.fn() }));

// eslint-disable-next-line import/first
import VerifyRoute from "../dashboard.verify";

describe("/dashboard/verify expired screen", () => {
  it("keeps the resend CTA when the browser has a session", () => {
    loaderDataRef.current = { ok: false, hasSession: true };
    const html = renderToStaticMarkup(createElement(VerifyRoute));
    expect(html).toContain('href="/dashboard/verify-needed"');
    expect(html).toContain("Request a new one");
  });

  it("offers a sign-in CTA when there is no session", () => {
    loaderDataRef.current = { ok: false, hasSession: false };
    const html = renderToStaticMarkup(createElement(VerifyRoute));
    expect(html).not.toContain('href="/dashboard/verify-needed"');
    expect(html).toContain("Sign in to resend the link");
    expect(html).toContain('href="/login"');
  });
});
