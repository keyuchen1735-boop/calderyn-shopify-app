#!/usr/bin/env node

import { createServer } from "vite";

if (process.argv.includes("--update-baselines")) {
  throw new Error("Existing storefront baselines are immutable; use --capture-new-baselines for a new recipe version.");
}
const updateBaselines = process.argv.includes("--capture-new-baselines");
const filter = process.argv.find((argument) => argument.startsWith("--filter="))?.slice("--filter=".length);
const vite = await createServer({
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

try {
  const { verifyStorefrontBundles } = await vite.ssrLoadModule("/app/lib/storefront-validation/verify.server.ts");
  const { report } = await verifyStorefrontBundles({
    updateBaselines,
    filter,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });
  if (!report.ok) {
    process.stderr.write(`Storefront browser proof failed with ${report.diagnostics.length} diagnostics:\n`);
    for (const diagnostic of report.diagnostics) {
      process.stderr.write(`- ${diagnostic.artifactId ?? "bundle"}:${diagnostic.routeId}@${diagnostic.viewport ?? "all"} ${diagnostic.code}: ${diagnostic.message}\n`);
      if (diagnostic.detail) process.stderr.write(`  ${JSON.stringify(diagnostic.detail)}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`Storefront browser proof passed ${report.cases ?? 0} cases in ${report.browserMs}ms.\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await vite.close();
}
