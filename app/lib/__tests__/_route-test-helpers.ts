import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/**
 * Builds the full framework-provided loader/action argument object from the
 * pieces a test cares about. React Router requires `url` and `pattern` on the
 * args; the framework derives both from the request/route at runtime, so tests
 * derive `url` the same way and use an empty pattern (no route under test
 * reads it).
 */
export function routeArgs(init: {
  request: Request;
  params?: Record<string, string | undefined>;
  context?: unknown;
}): LoaderFunctionArgs & ActionFunctionArgs {
  return {
    request: init.request,
    params: init.params ?? {},
    context: init.context ?? {},
    url: new URL(init.request.url),
    pattern: "",
  } as LoaderFunctionArgs & ActionFunctionArgs;
}

interface DataWithResponseInitLike {
  type: "DataWithResponseInit";
  data: unknown;
  init: ResponseInit | null;
}

function isDataWithResponseInit(v: unknown): v is DataWithResponseInitLike {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === "DataWithResponseInit"
  );
}

/**
 * Normalizes a loader/action result to the `Response` the HTTP layer would
 * produce, so tests keep asserting on status/headers/body regardless of
 * whether the route returns a real `Response` (redirects, resource routes) or
 * a `data()` payload (UI routes): `data()` results become a JSON response with
 * their ResponseInit applied, exactly as the single-fetch encoder reports them
 * to the client.
 */
export function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  const payload = isDataWithResponseInit(result) ? result.data : result;
  const init: ResponseInit = isDataWithResponseInit(result)
    ? (result.init ?? {})
    : {};
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(payload), { ...init, headers });
}
