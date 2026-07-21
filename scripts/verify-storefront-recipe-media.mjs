import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const templateIds = ["volt", "atelier", "gilt", "larder", "ember", "roast", "fizz", "forge", "haven", "glow"];
const templateIdSet = new Set(templateIds);
const requiredRoles = ["hero", "hero-alt", "pdp-detail"];

function publicAssetBaseUrl() {
  const explicit = process.env.STOREFRONT_RECIPE_ASSET_BASE_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  return supabaseUrl ? `${supabaseUrl}/storage/v1/object/public` : null;
}

async function resolveMediaPath(entry, manifestPath, downloadDir) {
  if (typeof entry.localPath === "string" && entry.localPath) {
    const localPath = resolve(dirname(manifestPath), entry.localPath);
    try {
      await access(localPath);
      return localPath;
    } catch {
      // Fall through to the immutable public object when a local derivative is absent.
    }
  }
  const baseUrl = publicAssetBaseUrl();
  if (!baseUrl) throw new Error(`No readable local derivative or public Supabase URL for ${entry.objectPath}`);
  const url = `${baseUrl}/${entry.objectPath}`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Failed to fetch immutable media ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Failed to fetch immutable media ${url}: HTTP ${response.status}`);
  const localPath = join(downloadDir, `${entry.contentHash}.${entry.mediaType === "video/mp4" ? "mp4" : entry.mediaType === "video/webm" ? "webm" : "webp"}`);
  await writeFile(localPath, Buffer.from(await response.arrayBuffer()));
  return localPath;
}

function assertRoleContract(manifest, expectedTemplateId) {
  if (!templateIdSet.has(manifest.templateId)) throw new Error(`Unknown new recipe template ownership: ${manifest.templateId}`);
  if (expectedTemplateId && manifest.templateId !== expectedTemplateId) {
    throw new Error(`Template ownership mismatch: expected ${expectedTemplateId}, received ${manifest.templateId}`);
  }
  if (!Array.isArray(manifest.records) || manifest.records.length !== requiredRoles.length) {
    throw new Error("Media manifest requires exactly one role record for hero, hero-alt, and pdp-detail");
  }
  const remaining = new Set(requiredRoles);
  const masterHashes = new Set();
  for (const record of manifest.records) {
    if (record?.templateId !== manifest.templateId) throw new Error(`Role ownership mismatch for ${record?.role ?? "unknown"}: expected ${manifest.templateId}`);
    if (!remaining.delete(record.role)) throw new Error(`Unexpected or duplicate media role: ${record.role}`);
    if (!record.masterHash || masterHashes.has(record.masterHash)) throw new Error("Each required role must have a distinct masterHash");
    masterHashes.add(record.masterHash);
  }
  if (remaining.size > 0) throw new Error("Media manifest requires exactly one role record for hero, hero-alt, and pdp-detail");
}

function assertProof(proofRecords, record) {
  const proof = proofRecords.find((proof) => proof?.templateId === record.templateId && proof?.role === record.role && proof?.masterHash === record.masterHash &&
    proof?.technicalApproval?.approved === true && proof.technicalApproval.masterHash === record.masterHash &&
    proof?.visualApproval?.approved === true && proof.visualApproval.scope === "full-loop");
  if (!proof) {
    throw new Error(`video-proof.json requires a matching template, role, and master approval identity with technical and full-loop visual approval for ${record.role}`);
  }
  const approvedHashes = proof.technicalApproval.derivativeHashes;
  const derivativeHashes = record.entries?.map(({ contentHash }) => contentHash).sort();
  if (!Array.isArray(approvedHashes) || JSON.stringify([...approvedHashes].sort()) !== JSON.stringify(derivativeHashes)) {
    throw new Error(`video-proof.json derivative hash approval mismatch for ${record.role}`);
  }
  return proof;
}

async function verifyRecord(manifest, record, proofRecords, manifestPath, downloadDir) {
  const proof = assertProof(proofRecords, record);
  const expectedTypes = new Set(["video/mp4", "video/webm", "image/webp"]);
  const dimensions = [];
  const durations = [];
  if (!Array.isArray(record.entries) || record.entries.length !== 3) throw new Error(`${record.role} must contain MP4, WebM, and poster entries`);
  for (const entry of record.entries) {
    if (!expectedTypes.delete(entry.mediaType)) throw new Error(`Unexpected or duplicate media type ${entry.mediaType} for ${record.role}`);
    const extension = entry.mediaType === "video/mp4" ? "mp4" : entry.mediaType === "video/webm" ? "webm" : "webp";
    if (entry.objectPath !== `storefront-recipe-assets/${manifest.templateId}/${entry.contentHash}.${extension}`) throw new Error(`Object path is not content-addressed for ${record.role}`);
    const localPath = await resolveMediaPath(entry, manifestPath, downloadDir);
    const bytes = await readFile(localPath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== entry.contentHash || bytes.byteLength !== entry.byteSize) throw new Error(`Hash or byte size mismatch for ${localPath}`);
    const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", localPath], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ffprobe failed for ${localPath}: ${result.stderr.trim()}`);
    const metadata = JSON.parse(result.stdout);
    const stream = metadata.streams?.[0];
    if (!stream?.width || !stream?.height) throw new Error(`Missing dimensions for ${localPath}`);
    dimensions.push(`${stream.width}x${stream.height}`);
    if (entry.mediaType.startsWith("video/")) {
      const duration = Number(metadata.format?.duration);
      if (!Number.isFinite(duration) || duration < 8 || duration > 12) throw new Error(`Video duration outside 8-12 seconds for ${localPath}`);
      durations.push(duration);
      const expectedCodec = entry.mediaType === "video/mp4" ? "h264" : "vp9";
      if (stream.codec_name !== expectedCodec) throw new Error(`Unexpected codec for ${localPath}`);
    }
    if (entry.mediaType === "image/webp" && stream.codec_name !== "webp") throw new Error(`Unexpected WebP poster codec for ${localPath}`);
  }
  if (expectedTypes.size > 0) throw new Error(`${record.role} is missing a required media derivative`);
  if (new Set(dimensions).size !== 1 || dimensions[0] !== `${proof.width}x${proof.height}`) {
    throw new Error(`Derivative dimension mismatch with video-proof.json for ${record.role}`);
  }
  const proofDuration = proof.duration;
  if (typeof proofDuration !== "number" || !Number.isFinite(proofDuration)) {
    throw new Error(`video-proof.json requires a finite proof duration for ${record.role}`);
  }
  if (durations.length !== 2 || Math.abs(durations[0] - durations[1]) > 0.25 ||
    durations.some((duration) => Math.abs(duration - proofDuration) > 0.25)) {
    throw new Error(`Derivative duration mismatch with video-proof.json for ${record.role}`);
  }
  process.stdout.write(`Verified ${manifest.templateId}/${record.role} ${record.masterHash}\n`);
}

async function verify(manifestInput, proofInput, expectedTemplateId) {
  const manifestPath = resolve(manifestInput);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const proof = JSON.parse(await readFile(resolve(proofInput), "utf8"));
  const proofRecords = Array.isArray(proof) ? proof : Array.isArray(proof.records) ? proof.records : [proof];
  assertRoleContract(manifest, expectedTemplateId);
  const downloadDir = await mkdtemp(join(tmpdir(), "storefront-recipe-verify-"));
  try {
    for (const record of manifest.records) await verifyRecord(manifest, record, proofRecords, manifestPath, downloadDir);
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

async function verifyTemplate(templateId) {
  if (!templateIdSet.has(templateId)) throw new Error(`Unknown new recipe template: ${templateId}`);
  const recipePath = resolve("app", "lib", "storefront-recipes", templateId);
  const manifestPath = join(recipePath, "media-manifest.json");
  const proofPath = join(recipePath, "video-proof.json");
  try {
    await verify(manifestPath, proofPath, templateId);
  } catch (error) {
    throw new Error(`Failed to verify ${templateId} using ${manifestPath} and ${proofPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  for (const templateId of templateIds) await verifyTemplate(templateId);
} else if (args.length === 2 && args[0] === "--template") {
  await verifyTemplate(args[1]);
} else if (args.length === 2 && !args[0].startsWith("--")) {
  await verify(args[0], args[1]);
} else {
  throw new Error("Usage: node scripts/verify-storefront-recipe-media.mjs [--template <id> | <manifest.json> <video-proof.json>]");
}
