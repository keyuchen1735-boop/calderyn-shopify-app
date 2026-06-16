import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the 2026-06-16 production outage.
//
// A Remix route and a Python serverless function must never resolve to the same
// URL. When they do, both compile to the SAME Vercel build-output function dir
// (e.g. api/engine/run.func) — @vercel/remix-builder then drops the Node server
// bundle and every route symlinks to the surviving POST-only Python function, so
// every GET returns 501 "Unsupported method ('GET')" (a full outage). Commit
// e0a32fb added app/routes/api.engine.run.tsx at /api/engine/run, a path already
// owned by api/engine/run.py, and took the whole app down.
//
// Each api/**/*.py reserves its URL /api/<path>. A Remix flat-route file claims
// the same URL when its dotted name equals "api.<path with '/' -> '.'>". Fail if
// any such collision exists.
const here = dirname(fileURLToPath(import.meta.url));
const routesDir = join(here, ".."); // app/routes
const apiDir = join(here, "..", "..", "..", "api"); // repo-root /api

function pyFunctionRouteNames(dir: string, prefix = "api"): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...pyFunctionRouteNames(child, `${prefix}.${entry.name}`));
    } else if (entry.name.endsWith(".py")) {
      names.push(`${prefix}.${entry.name.replace(/\.py$/, "")}`);
    }
  }
  return names;
}

describe("Remix routes never collide with Python serverless functions", () => {
  it("has no app/routes/* file sharing a URL with any api/**/*.py", () => {
    const reserved = new Set(pyFunctionRouteNames(apiDir)); // e.g. "api.engine.run"
    const routeFiles = readdirSync(routesDir)
      .filter((f) => /\.(tsx?|jsx?)$/.test(f))
      .map((f) => f.replace(/\.(tsx?|jsx?)$/, ""));
    const collisions = routeFiles.filter((name) => reserved.has(name));
    expect(collisions).toEqual([]);
  });
});
