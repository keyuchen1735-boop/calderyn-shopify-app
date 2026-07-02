import { describe, expect, it, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { LoaderFunctionArgs } from "react-router";

const { loginMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  login: loginMock,
}));

vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    AppProvider: Stub,
    BlockStack: Stub,
    Button: Stub,
    Card: Stub,
    FormLayout: Stub,
    Page: Stub,
    Text: Stub,
    TextField: Stub,
  };
});

vi.mock("@shopify/polaris/build/esm/styles.css?url", () => ({
  default: "/polaris.css",
}));

vi.mock("@shopify/polaris/locales/en.json", () => ({
  default: {},
}));

// eslint-disable-next-line import/first
import { loader } from "../auth.login";

function callLoader(url: string, headers?: HeadersInit) {
  return loader({ request: new Request(url, { headers }) } as unknown as LoaderFunctionArgs);
}

async function captureRedirect(promise: Promise<unknown>): Promise<Response> {
  const thrown = await promise.then(
    () => null,
    (e) => e,
  );
  expect(thrown).toBeInstanceOf(Response);
  return thrown as Response;
}

beforeEach(() => {
  loginMock.mockReset();
  loginMock.mockResolvedValue({});
});

describe("/auth/login embedded fallback guard", () => {
  it("redirects an embedded auth fallback back to the app route from the referer", async () => {
    const res = await captureRedirect(
      callLoader("https://app.calderyncompany.com/auth/login", {
        referer:
          "https://app.calderyncompany.com/app/alerts?shop=calderyn-review-store.myshopify.com&host=abc&embedded=1",
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/app/alerts?shop=calderyn-review-store.myshopify.com&host=abc&embedded=1",
    );
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("redirects an embedded auth fallback with current query context back to /app", async () => {
    const res = await captureRedirect(
      callLoader(
        "https://app.calderyncompany.com/auth/login?shop=calderyn-review-store.myshopify.com&host=abc&embedded=1",
      ),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/app?shop=calderyn-review-store.myshopify.com&host=abc&embedded=1",
    );
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("still allows a standalone login page request with no embedded context", async () => {
    const res = toResponse(await callLoader("https://app.calderyncompany.com/auth/login"));

    expect(res.status).toBe(200);
    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  it("still lets Shopify's normal login handler own a standalone shop query", async () => {
    const res = toResponse(await callLoader(
      "https://app.calderyncompany.com/auth/login?shop=calderyn-review-store.myshopify.com",
    ));

    expect(res.status).toBe(200);
    expect(loginMock).toHaveBeenCalledTimes(1);
  });
});
