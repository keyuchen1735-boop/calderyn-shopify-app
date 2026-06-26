// Typed window-CustomEvent seam between the Calderyn Log (Action Queue feed) and
// the Live Engine hero: the page dispatches `le-*` events, the hero reacts. These
// carry real data (a genuinely approved action, the real calibration nudge); see
// CalderynLog.tsx for where they are fired.

/** The four Watching groups the hero renders, left to right. */
export type WatchGroup = "inv" | "ads" | "price" | "ret";

export interface LeDockDetail {
  /** Target Watching group the approved item docks into. */
  group: WatchGroup;
  /** Action label shown on the chip and in the Acting card. */
  label: string;
  /** Formatted money result on completion, e.g. "$640". */
  money?: string;
  /** Short suffix after the money, e.g. "protected". */
  moneyShort?: string;
  /** Acting-card step checklist; falls back to a generic three-step run. */
  steps?: string[];
  /** Icon name for the Acting card (CD_ICONS / hero ICO key). */
  icon?: string;
}

export interface LeCalibrateDetail {
  kind: "approve" | "deny";
}

export interface LeDidDetail {
  icon?: string;
  title: string;
  steps?: string[];
  money?: string;
  moneyShort?: string;
}

type LeEventMap = {
  "le-openreason": undefined;
  "le-dock": LeDockDetail;
  "le-calibrate": LeCalibrateDetail;
  "le-did": LeDidDetail;
};

export function emitEngine<K extends keyof LeEventMap>(
  type: K,
  detail?: LeEventMap[K],
): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    /* CustomEvent unsupported (non-browser) — no-op */
  }
}

export function onEngine<K extends keyof LeEventMap>(
  type: K,
  handler: (detail: LeEventMap[K]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<LeEventMap[K]>).detail);
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}
