import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [manifestInput, proofInput] = process.argv.slice(2);
if (!manifestInput || !proofInput) throw new Error("Usage: node scripts/verify-storefront-recipe-media.mjs <manifest.json> <video-proof.json>");
const manifest = JSON.parse(await readFile(resolve(manifestInput), "utf8"));
const proof = JSON.parse(await readFile(resolve(proofInput), "utf8"));
const proofRecords = Array.isArray(proof) ? proof : Array.isArray(proof.records) ? proof.records : [proof];
if (!proofRecords.some((record) => record?.masterHash === manifest.masterHash && record?.approved === true)) {
  throw new Error("video-proof.json has no approved record for the exact master hash");
}
const expectedTypes = new Set(["video/mp4", "video/webm", "image/webp"]);
if (!Array.isArray(manifest.entries) || manifest.entries.length !== 3) throw new Error("Manifest must contain MP4, WebM, and poster entries");
for (const entry of manifest.entries) {
  if (!expectedTypes.delete(entry.mediaType)) throw new Error(`Unexpected or duplicate media type ${entry.mediaType}`);
  const bytes = await readFile(resolve(entry.localPath));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== entry.contentHash || bytes.byteLength !== entry.byteSize) throw new Error(`Hash or byte size mismatch for ${entry.localPath}`);
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", entry.localPath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed for ${entry.localPath}: ${result.stderr.trim()}`);
  const metadata = JSON.parse(result.stdout);
  const stream = metadata.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error(`Missing dimensions for ${entry.localPath}`);
  if (entry.mediaType.startsWith("video/")) {
    const duration = Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration < 8 || duration > 12) throw new Error(`Video duration outside 8-12 seconds for ${entry.localPath}`);
    const expectedCodec = entry.mediaType === "video/mp4" ? "h264" : "vp9";
    if (stream.codec_name !== expectedCodec) throw new Error(`Unexpected codec for ${entry.localPath}`);
  }
  if (!entry.objectPath?.startsWith(`storefront-recipe-assets/${manifest.templateId}/${entry.contentHash}.`)) throw new Error(`Object path is not content-addressed for ${entry.localPath}`);
}
if (expectedTypes.size > 0) throw new Error("Manifest is missing a required media derivative");
process.stdout.write(`Verified ${manifest.templateId}/${manifest.role} ${manifest.masterHash}\n`);
