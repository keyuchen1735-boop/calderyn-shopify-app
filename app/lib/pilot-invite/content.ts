// app/lib/pilot-invite/content.ts
// Shared, side-effect-free helpers for the pilot-invite email + landing templates.
// Pure (no env, no I/O) so both renderers and the routes can import it freely.

export const INSTALL_URL = "https://apps.shopify.com/calderynextension";
export const FEEDBACK_URL = "https://calderyncompany.com/pilot-feedback";
export const DEFAULT_FIRST_NAME = "there";
export const DEFAULT_STORE_NAME = "your store";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

/** Escape text for safe interpolation into HTML attribute/element context. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

export function markUrls(baseUrl: string): { teal: string; white: string } {
  const b = trimTrailingSlash(baseUrl);
  return { teal: `${b}/pilot-mark-teal.png`, white: `${b}/pilot-mark-white.png` };
}

export function viewInBrowserUrl(baseUrl: string, firstName: string, storeName: string): string {
  const b = trimTrailingSlash(baseUrl);
  const q = new URLSearchParams({ first_name: firstName, store_name: storeName });
  return `${b}/pilot?${q.toString()}`;
}
