// The "Continue with Google" button must start the OAuth round-trip on the
// canonical public host — the apex the __Host- CSRF cookie and the Google-
// registered redirect_uri live on — never a bare relative path. The auth pages
// are served on app.calderyncompany.com, so a relative href sets the state
// cookie on app.* while Google returns the browser to the apex callback; the
// host-only __Host- cookie is then never sent and the state check fails
// ("Google sign-in didn't complete"). Both /login and /signup carry the button.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import LoginPage from "../login";
// eslint-disable-next-line import/first
import SignupPage from "../signup";

const APEX = "https://calderyncompany.com";

describe("Google provider button host", () => {
  it("/login points the Google button at the apex start URL, not a relative path", () => {
    loaderDataRef.current = {
      error: null,
      notice: null,
      email: "",
      returnTo: null,
      authBase: APEX,
      accounts: [],
    };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(`href="${APEX}/dashboard/auth/google"`);
    // The bug: a bare relative href sets the CSRF cookie on the wrong host.
    expect(html).not.toContain('href="/dashboard/auth/google"');
  });

  it("/login carries return_to through the apex Google start URL", () => {
    loaderDataRef.current = {
      error: null,
      notice: null,
      email: "",
      returnTo: "/dashboard/connect?t=abc",
      authBase: APEX,
      accounts: [],
    };
    const html = renderToStaticMarkup(createElement(LoginPage));
    const enc = encodeURIComponent("/dashboard/connect?t=abc").replace(/&/g, "&amp;");
    expect(html).toContain(`href="${APEX}/dashboard/auth/google?return_to=${enc}"`);
  });

  it("/signup points the Google button at the apex start URL, not a relative path", () => {
    loaderDataRef.current = { error: null, email: "", store: "", authBase: APEX, accounts: [] };
    const html = renderToStaticMarkup(createElement(SignupPage));
    expect(html).toContain(`href="${APEX}/dashboard/auth/google"`);
    expect(html).not.toContain('href="/dashboard/auth/google"');
  });

  it("falls back to a relative href when no public base is configured (single-host dev)", () => {
    loaderDataRef.current = {
      error: null,
      notice: null,
      email: "",
      returnTo: null,
      authBase: "",
      accounts: [],
    };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain('href="/dashboard/auth/google"');
  });
});

describe("auth loaders expose the public base for the Google button", () => {
  it("signup loader returns authBase from the public origin env", async () => {
    const saved = process.env.DASHBOARD_PUBLIC_URL;
    process.env.DASHBOARD_PUBLIC_URL = APEX;
    try {
      const { loader } = await import("../signup");
      const res = await loader({
        request: new Request("https://app.calderyncompany.com/signup"),
        params: {},
        context: {},
      } as never);
      const data = await res.json();
      expect(data).toMatchObject({ authBase: APEX });
    } finally {
      if (saved === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
      else process.env.DASHBOARD_PUBLIC_URL = saved;
    }
  });
});
