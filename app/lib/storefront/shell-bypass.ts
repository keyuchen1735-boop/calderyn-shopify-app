// The storefront layout wraps classic block-built pages in the .cd-store chrome
// (header/nav/footer plus a centered max-width column). Any loader payload that
// carries a COMPLETE self-owned document must skip that chrome entirely, or the
// page renders inside the centered column with bars on both sides and a
// duplicate header. Every bare-serving payload shape belongs here so the layout
// has a single authoritative gate.
export function rendersOwnDocument(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as { runtime?: unknown; designer?: unknown };
  // Runtime-1 bundle pages ship their own shell inside the bundle.
  if (record.runtime === 1) return true;
  // Published designer pages carry their own header/footer and page CSS
  // (see DesignerPublicView) and are authored edge-to-edge.
  if (record.designer === true) return true;
  return false;
}
