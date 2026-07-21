import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const noUpload = args.includes("--no-upload");
const [templateId, role, masterInput, proofInput, outputInput] = args.filter((arg) => arg !== "--no-upload");
const templateIds = new Set(["larder"]);
const roles = new Set(["hero", "hero-alt", "pdp-detail"]);
if (!templateIds.has(templateId) || !roles.has(role) || !masterInput || !proofInput) {
  throw new Error("Usage: node scripts/import-storefront-recipe-media.mjs <templateId> <hero|hero-alt|pdp-detail> <master> <video-proof.json> [output-dir] [--no-upload]");
}
const masterPath = resolve(masterInput);
const proofPath = resolve(proofInput);
const outputDir = resolve(outputInput ?? join(dirname(masterPath), "derivatives", role));
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!noUpload && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless --no-upload is used");

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function probe(path) {
  return JSON.parse(command("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height", "-of", "json", path]));
}

async function asset(path, mediaType) {
  const bytes = await readFile(path);
  return { path, bytes, mediaType, byteSize: bytes.byteLength, contentHash: createHash("sha256").update(bytes).digest("hex") };
}

const proof = JSON.parse(await readFile(proofPath, "utf8"));
const masterBytes = await readFile(masterPath);
const masterHash = createHash("sha256").update(masterBytes).digest("hex");
const proofRecords = Array.isArray(proof) ? proof : Array.isArray(proof.records) ? proof.records : [proof];
if (!proofRecords.some((record) => record?.templateId === templateId && record?.role === role && record?.masterHash === masterHash &&
  record?.technicalApproval?.approved === true && record.technicalApproval.masterHash === masterHash &&
  record?.visualApproval?.approved === true && record.visualApproval.scope === "full-loop")) {
  throw new Error("video-proof.json requires a matching template, role, and master approval identity with technical and full-loop visual approval");
}
const masterProbe = probe(masterPath);
const duration = Number(masterProbe.format?.duration);
if (!Number.isFinite(duration) || duration < 8 || duration > 12) throw new Error("Master video duration must be between 8 and 12 seconds");
await mkdir(outputDir, { recursive: true });
const mp4Path = join(outputDir, `${role}.mp4`);
const webmPath = join(outputDir, `${role}.webm`);
const posterPath = join(outputDir, `${role}-poster.webp`);
const posterFramePath = join(outputDir, `${role}-poster.png`);
command("ffmpeg", ["-y", "-i", masterPath, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path]);
command("ffmpeg", ["-y", "-i", masterPath, "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", webmPath]);
command("ffmpeg", ["-y", "-i", masterPath, "-frames:v", "1", posterFramePath]);
command("cwebp", ["-quiet", posterFramePath, "-o", posterPath]);
await unlink(posterFramePath);

const derived = await Promise.all([
  asset(mp4Path, "video/mp4"),
  asset(webmPath, "video/webm"),
  asset(posterPath, "image/webp"),
]);
const supabase = noUpload ? null : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
for (const item of derived) {
  const extension = item.mediaType === "video/mp4" ? "mp4" : item.mediaType === "video/webm" ? "webm" : "webp";
  const objectKey = `${templateId}/${item.contentHash}.${extension}`;
  if (supabase) {
    const result = await supabase.storage.from("storefront-recipe-assets").upload(objectKey, item.bytes, { contentType: item.mediaType, upsert: false });
    if (result.error) throw new Error(`Upload failed for ${objectKey}: ${result.error.message}`);
  }
  item.objectPath = `storefront-recipe-assets/${objectKey}`;
}
const videoStream = masterProbe.streams?.find((stream) => stream.width && stream.height);
process.stdout.write(`${JSON.stringify({
  templateId,
  records: [{
    templateId,
    role,
    masterHash,
    duration,
    width: videoStream?.width,
    height: videoStream?.height,
    entries: derived.map(({ bytes: _bytes, path, ...entry }) => ({ ...entry, localPath: relative(dirname(proofPath), path) })),
  }],
}, null, 2)}\n`);
