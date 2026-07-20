import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

const importer = resolve("scripts/import-storefront-recipe-media.mjs");
const verifier = resolve("scripts/verify-storefront-recipe-media.mjs");
let directory;
let manifest;
let manifestPath;
let proofPath;

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function exactApproval(masterHash) {
  return {
    records: [{
      masterHash,
      technicalApproval: { approved: true, masterHash },
      visualApproval: { approved: true, scope: "full-loop" },
    }],
  };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "storefront-media-test-"));
  const masterPath = join(directory, "master.mp4");
  const generated = run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=12", "-t", "8",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", masterPath,
  ]);
  assert.equal(generated.status, 0, generated.stderr);
  const masterHash = createHash("sha256").update(await readFile(masterPath)).digest("hex");
  proofPath = join(directory, "video-proof.json");
  await writeFile(proofPath, JSON.stringify(exactApproval(masterHash)));

  const imported = run(process.execPath, [importer, "volt", "hero", masterPath, proofPath, join(directory, "derived"), "--no-upload"]);
  assert.equal(imported.status, 0, imported.stderr);
  manifest = JSON.parse(imported.stdout);
  manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("normalizes and verifies synthetic media without uploading", () => {
  const verified = run(process.execPath, [verifier, manifestPath, proofPath]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Verified volt\/hero/);
});

test("rejects legacy approval without separate technical and full-loop visual approvals", async () => {
  const legacyProof = join(directory, "legacy-proof.json");
  await writeFile(legacyProof, JSON.stringify({ masterHash: manifest.masterHash, approved: true }));
  const verified = run(process.execPath, [verifier, manifestPath, legacyProof]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /technical.*visual|approval/i);
});

test("rejects a poster whose bytes are not WebP", async () => {
  const invalidPoster = join(directory, "invalid-poster.png");
  const generated = run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64", "-frames:v", "1", invalidPoster]);
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = await readFile(invalidPoster);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const invalid = structuredClone(manifest);
  invalid.entries = invalid.entries.map((entry) => entry.mediaType === "image/webp"
    ? { ...entry, localPath: invalidPoster, contentHash: hash, byteSize: bytes.byteLength, objectPath: `storefront-recipe-assets/volt/${hash}.webp` }
    : entry);
  const invalidManifest = join(directory, "invalid-poster-manifest.json");
  await writeFile(invalidManifest, JSON.stringify(invalid));

  const verified = run(process.execPath, [verifier, invalidManifest, proofPath]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /codec|webp/i);
});

test("rejects an extension-specific object path mismatch", async () => {
  const invalid = structuredClone(manifest);
  invalid.entries[0].objectPath = `storefront-recipe-assets/volt/${invalid.entries[0].contentHash}.wrong`;
  const invalidManifest = join(directory, "invalid-path-manifest.json");
  await writeFile(invalidManifest, JSON.stringify(invalid));

  const verified = run(process.execPath, [verifier, invalidManifest, proofPath]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /object path/i);
});
