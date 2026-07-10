// Photo intake rules for the new-product flow. Framework-free so the
// accept/reject behavior is unit-testable; the component injects
// URL.createObjectURL as makeUrl.

// Mirrors app/lib/catalog/media.server.ts (server-only module, so the
// constants can't be imported here). Checked at pick time so a photo that can
// never upload is rejected before it rides through every preview.
export const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export type PhotoDraft = { file: File; url: string };

export type PhotoRejection = { name: string; reason: "type" | "size" | "limit" };

// Validates each picked file (type, then size, then remaining capacity) and
// appends the survivors in pick order. Never mutates `cur`; every accepted
// file gets exactly one URL from makeUrl, so the caller owns revocation.
export function addPhotos(
  cur: PhotoDraft[],
  files: File[],
  max: number,
  makeUrl: (f: File) => string,
): { next: PhotoDraft[]; rejected: PhotoRejection[] } {
  const next = [...cur];
  const rejected: PhotoRejection[] = [];
  for (const file of files) {
    if (!PHOTO_TYPES.has(file.type)) {
      rejected.push({ name: file.name, reason: "type" });
      continue;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      rejected.push({ name: file.name, reason: "size" });
      continue;
    }
    if (next.length >= max) {
      rejected.push({ name: file.name, reason: "limit" });
      continue;
    }
    next.push({ file, url: makeUrl(file) });
  }
  return { next, rejected };
}

const REASON_LABEL: Record<PhotoRejection["reason"], string> = {
  type: "unsupported type",
  size: "too large",
  limit: "over the photo limit",
};

// One toast per pick, however many files bounced: "2 photos skipped (too
// large)." — mixed reasons get a per-reason count breakdown.
export function summarizePhotoRejections(rejected: PhotoRejection[]): string | null {
  if (rejected.length === 0) return null;
  const counts = new Map<PhotoRejection["reason"], number>();
  for (const r of rejected) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const noun = rejected.length === 1 ? "photo" : "photos";
  const detail =
    counts.size === 1
      ? REASON_LABEL[rejected[0].reason]
      : Array.from(counts.entries())
          .map(([reason, n]) => `${n} ${REASON_LABEL[reason]}`)
          .join(", ");
  return `${rejected.length} ${noun} skipped (${detail}).`;
}
