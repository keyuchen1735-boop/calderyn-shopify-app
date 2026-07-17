#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const manifestPath = resolve(root, "app/lib/storefront-validation/design-provenance.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];

if (manifest.schemaVersion !== 1 || typeof manifest.artifacts !== "object" || manifest.artifacts === null) {
  failures.push("design provenance manifest is malformed");
} else {
  for (const [artifact, expectedHash] of Object.entries(manifest.artifacts)) {
    try {
      const bytes = await readFile(resolve(root, artifact));
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== expectedHash) failures.push(`${artifact}: expected ${expectedHash}, received ${actualHash}`);
    } catch (error) {
      failures.push(`${artifact}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Storefront design provenance failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Storefront design provenance passed ${Object.keys(manifest.artifacts).length} immutable artifacts.\n`);
}
