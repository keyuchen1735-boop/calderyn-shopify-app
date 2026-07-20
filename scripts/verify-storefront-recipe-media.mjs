import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const templateIds = ["volt", "atelier", "gilt", "larder", "ember", "roast", "fizz", "forge", "haven", "glow"];
const templateIdSet = new Set(templateIds);

async function verify(manifestInput, proofInput) {
  const manifestPath = resolve(manifestInput);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const proof = JSON.parse(await readFile(resolve(proofInput), "utf8"));
  const proofRecords = Array.isArray(proof) ? proof : Array.isArray(proof.records) ? proof.records : [proof];
  if (!proofRecords.some((record) => record?.masterHash === manifest.masterHash &&
    record?.technicalApproval?.approved === true && record.technicalApproval.masterHash === manifest.masterHash &&
    record?.visualApproval?.approved === true && record.visualApproval.scope === "full-loop")) {
    throw new Error("video-proof.json requires exact-master technical approval and full-loop visual approval");
  }
  const expectedTypes = new Set(["video/mp4", "video/webm", "image/webp"]);
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== 3) throw new Error("Manifest must contain MP4, WebM, and poster entries");
  for (const entry of manifest.entries) {
    if (!expectedTypes.delete(entry.mediaType)) throw new Error(`Unexpected or duplicate media type ${entry.mediaType}`);
    const localPath = resolve(dirname(manifestPath), entry.localPath);
    const bytes = await readFile(localPath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== entry.contentHash || bytes.byteLength !== entry.byteSize) throw new Error(`Hash or byte size mismatch for ${localPath}`);
    const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", localPath], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ffprobe failed for ${localPath}: ${result.stderr.trim()}`);
    const metadata = JSON.parse(result.stdout);
    const stream = metadata.streams?.[0];
    if (!stream?.width || !stream?.height) throw new Error(`Missing dimensions for ${localPath}`);
    if (entry.mediaType.startsWith("video/")) {
      const duration = Number(metadata.format?.duration);
      if (!Number.isFinite(duration) || duration < 8 || duration > 12) throw new Error(`Video duration outside 8-12 seconds for ${localPath}`);
      const expectedCodec = entry.mediaType === "video/mp4" ? "h264" : "vp9";
      if (stream.codec_name !== expectedCodec) throw new Error(`Unexpected codec for ${localPath}`);
    }
    if (entry.mediaType === "image/webp" && stream.codec_name !== "webp") throw new Error(`Unexpected WebP poster codec for ${localPath}`);
    const extension = entry.mediaType === "video/mp4" ? "mp4" : entry.mediaType === "video/webm" ? "webm" : "webp";
    if (entry.objectPath !== `storefront-recipe-assets/${manifest.templateId}/${entry.contentHash}.${extension}`) throw new Error(`Object path is not content-addressed for ${localPath}`);
  }
  if (expectedTypes.size > 0) throw new Error("Manifest is missing a required media derivative");
  process.stdout.write(`Verified ${manifest.templateId}/${manifest.role} ${manifest.masterHash}\n`);
}

async function verifyTemplate(templateId) {
  if (!templateIdSet.has(templateId)) throw new Error(`Unknown new recipe template: ${templateId}`);
  const recipePath = resolve("app", "lib", "storefront-recipes", templateId);
  const manifestPath = join(recipePath, "media-manifest.json");
  const proofPath = join(recipePath, "video-proof.json");
  try {
    await verify(manifestPath, proofPath);
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
