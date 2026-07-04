// The /dashboard/auth/google start route's loader ALWAYS redirects to Google's
// authorize endpoint. Under flatRoutes, a file named `dashboard.auth.google.<x>.tsx`
// NESTS under that start route, so a GET to `/dashboard/auth/google/<x>` runs the
// start loader first and 302s straight to Google before the child's own loader can
// render — the "name your store" step became unreachable and new Google users
// looped on the account picker (callback -> store -> Google -> callback -> ...).
//
// Children must opt out of nesting with the trailing-underscore form
// (`dashboard.auth.google_.<x>.tsx`), which keeps the same URL
// (/dashboard/auth/google/<x>) but re-parents to root so their own loader runs.
// This test guards against reintroducing a nesting child.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const routeFiles = readdirSync(routesDir).filter((f) => /\.(tsx|jsx)$/.test(f));

describe("google auth routes must not nest under the redirecting start route", () => {
  it("has no dashboard.auth.google.<child> file (it would be preempted by the start loader's redirect)", () => {
    const nested = routeFiles.filter((f) => /^dashboard\.auth\.google\.[^.]+\.(tsx|jsx)$/.test(f));
    expect(nested).toEqual([]);
  });

  it("still serves the callback and store under /dashboard/auth/google via the un-nested form", () => {
    expect(routeFiles).toContain("dashboard.auth.google_.callback.tsx");
    expect(routeFiles).toContain("dashboard.auth.google_.store.tsx");
  });
});
