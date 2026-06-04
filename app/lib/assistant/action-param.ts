import type { ActionKind } from "../types";

/** Returns the action kind from a ?action= param only if it's allowed for this alert. */
export function resolveActionParam(
  raw: string | null,
  allowed: ActionKind[],
): ActionKind | null {
  if (!raw) return null;
  return (allowed as string[]).includes(raw) ? (raw as ActionKind) : null;
}
