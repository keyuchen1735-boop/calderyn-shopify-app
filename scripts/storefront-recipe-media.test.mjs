import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

const importer = resolve("scripts/import-storefront-recipe-media.mjs");
const verifier = resolve("scripts/verify-storefront-recipe-media.mjs");
const templateIds = ["volt", "atelier", "gilt", "larder", "ember", "roast", "fizz", "forge", "haven", "glow"];
const roles = ["hero", "hero-alt", "pdp-detail"];
let directory;
let importedManifest;
let manifest;
let manifestPath;
let proofPath;
let repositoryPath;
let publicAssetBaseUrl;
let server;
let verificationTmp;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function runAsync(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
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

function recordFor(baseRecord, templateId, role, includeLocalPath) {
  return {
    ...baseRecord,
    templateId,
    role,
    entries: baseRecord.entries.map((entry) => ({
      ...entry,
      ...(includeLocalPath ? {} : { localPath: undefined }),
      objectPath: entry.objectPath.replace("storefront-recipe-assets/volt/", `storefront-recipe-assets/${templateId}/`),
    })),
  };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "storefront-media-test-"));
  verificationTmp = join(directory, "verify-tmp");
  await mkdir(verificationTmp);
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
  importedManifest = JSON.parse(imported.stdout);
  const baseRecord = importedManifest.records?.[0] ?? {
    templateId: importedManifest.templateId,
    role: importedManifest.role,
    masterHash: importedManifest.masterHash,
    duration: importedManifest.duration,
    width: importedManifest.width,
    height: importedManifest.height,
    entries: importedManifest.entries,
  };
  manifest = { templateId: "volt", records: roles.map((role) => recordFor(baseRecord, "volt", role, true)) };
  manifestPath = join(directory, "media-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));

  const bytesByExtension = new Map();
  for (const entry of baseRecord.entries) bytesByExtension.set(extname(entry.objectPath), await readFile(join(directory, entry.localPath)));
  server = createServer((request, response) => {
    const bytes = bytesByExtension.get(extname(new URL(request.url, "http://localhost").pathname));
    if (!bytes) {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  publicAssetBaseUrl = `http://127.0.0.1:${address.port}/storage/v1/object/public`;

  repositoryPath = join(directory, "repository");
  for (const templateId of templateIds) {
    const recipePath = join(repositoryPath, "app", "lib", "storefront-recipes", templateId);
    const recipeManifest = { templateId, records: roles.map((role) => recordFor(baseRecord, templateId, role, false)) };
    await mkdir(recipePath, { recursive: true });
    await writeFile(join(recipePath, "media-manifest.json"), JSON.stringify(recipeManifest));
    await writeFile(join(recipePath, "video-proof.json"), JSON.stringify(exactApproval(masterHash)));
  }
});

after(async () => {
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
});

test("importer emits one portable record without an absolute proof path", () => {
  assert.equal(importedManifest.templateId, "volt");
  assert.equal(importedManifest.records.length, 1);
  assert.equal(importedManifest.records[0].templateId, "volt");
  assert.equal(importedManifest.records[0].role, "hero");
  assert.equal(importedManifest.records[0].entries.every((entry) => !isAbsolute(entry.localPath)), true);
  assert.equal("proofPath" in importedManifest, false);
});

test("verifies exactly one local derivative record for every required role", () => {
  const verified = run(process.execPath, [verifier, manifestPath, proofPath]);
  assert.equal(verified.status, 0, verified.stderr);
  for (const role of roles) assert.match(verified.stdout, new RegExp(`Verified volt/${role}`));
});

test("rejects missing, duplicate, and unexpected roles", async (context) => {
  const cases = {
    missing: manifest.records.slice(0, 2),
    duplicate: [manifest.records[0], manifest.records[0], manifest.records[2]],
    unexpected: [manifest.records[0], manifest.records[1], { ...manifest.records[2], role: "lookbook" }],
  };
  for (const [label, records] of Object.entries(cases)) {
    await context.test(label, async () => {
      const path = join(directory, `${label}-roles.json`);
      await writeFile(path, JSON.stringify({ templateId: "volt", records }));
      const verified = run(process.execPath, [verifier, path, proofPath]);
      assert.notEqual(verified.status, 0);
      assert.match(verified.stderr, /exactly one.*hero.*hero-alt.*pdp-detail|role/i);
    });
  }
});

test("discovers one template and fetches immutable public objects without local binaries", async () => {
  const verified = await runAsync(process.execPath, [verifier, "--template", "volt"], {
    cwd: repositoryPath,
    env: { ...process.env, STOREFRONT_RECIPE_ASSET_BASE_URL: publicAssetBaseUrl, TMPDIR: verificationTmp },
  });
  assert.equal(verified.status, 0, verified.stderr);
  for (const role of roles) assert.match(verified.stdout, new RegExp(`Verified volt/${role}`));
  assert.deepEqual(await readdir(verificationTmp), []);
});

test("fails loudly when media is neither local nor publicly fetchable", async () => {
  const unavailable = structuredClone(manifest);
  unavailable.records.forEach((record) => {
    record.entries = record.entries.map((entry) => ({ ...entry, localPath: "missing/derivative" }));
  });
  const path = join(directory, "unavailable-media-manifest.json");
  await writeFile(path, JSON.stringify(unavailable));
  const env = { ...process.env };
  delete env.STOREFRONT_RECIPE_ASSET_BASE_URL;
  delete env.SUPABASE_URL;
  const verified = run(process.execPath, [verifier, path, proofPath], { env });
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /No readable local derivative or public Supabase URL/);
});

test("discovers all thirty required recipe records", async () => {
  const verified = await runAsync(process.execPath, [verifier], {
    cwd: repositoryPath,
    env: { ...process.env, STOREFRONT_RECIPE_ASSET_BASE_URL: publicAssetBaseUrl, TMPDIR: verificationTmp },
  });
  assert.equal(verified.status, 0, verified.stderr);
  for (const templateId of templateIds) {
    for (const role of roles) assert.match(verified.stdout, new RegExp(`Verified ${templateId}/${role}`));
  }
  assert.deepEqual(await readdir(verificationTmp), []);
});

test("template discovery rejects manifest and role ownership mismatches", async () => {
  const path = join(repositoryPath, "app", "lib", "storefront-recipes", "volt", "media-manifest.json");
  const invalid = structuredClone(manifest);
  invalid.templateId = "atelier";
  invalid.records[0].templateId = "glow";
  invalid.records.forEach((record) => { record.entries = record.entries.map(({ localPath: _localPath, ...entry }) => entry); });
  await writeFile(path, JSON.stringify(invalid));
  try {
    const verified = await runAsync(process.execPath, [verifier, "--template", "volt"], {
      cwd: repositoryPath,
      env: { ...process.env, STOREFRONT_RECIPE_ASSET_BASE_URL: publicAssetBaseUrl },
    });
    assert.notEqual(verified.status, 0);
    assert.match(verified.stderr, /expected volt|ownership|template/i);
  } finally {
    const baseRecord = manifest.records[0];
    const restored = { templateId: "volt", records: roles.map((role) => recordFor(baseRecord, "volt", role, false)) };
    await writeFile(path, JSON.stringify(restored));
  }
});

test("all-template discovery fails loudly on incomplete proof", async () => {
  const proof = join(repositoryPath, "app", "lib", "storefront-recipes", "glow", "video-proof.json");
  await writeFile(proof, JSON.stringify({ masterHash: manifest.records[0].masterHash, technicalApproval: { approved: true, masterHash: manifest.records[0].masterHash } }));
  const verified = await runAsync(process.execPath, [verifier], {
    cwd: repositoryPath,
    env: { ...process.env, STOREFRONT_RECIPE_ASSET_BASE_URL: publicAssetBaseUrl },
  });
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /glow/);
  assert.match(verified.stderr, /video-proof\.json/);
  assert.match(verified.stderr, /full-loop visual approval/i);
});

test("rejects a poster whose bytes are not WebP", async () => {
  const invalidPoster = join(directory, "invalid-poster.png");
  const generated = run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64", "-frames:v", "1", invalidPoster]);
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = await readFile(invalidPoster);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const invalid = structuredClone(manifest);
  invalid.records[0].entries = invalid.records[0].entries.map((entry) => entry.mediaType === "image/webp"
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
  invalid.records[0].entries[0].objectPath = `storefront-recipe-assets/volt/${invalid.records[0].entries[0].contentHash}.wrong`;
  const invalidManifest = join(directory, "invalid-path-manifest.json");
  await writeFile(invalidManifest, JSON.stringify(invalid));
  const verified = run(process.execPath, [verifier, invalidManifest, proofPath]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /object path/i);
});
