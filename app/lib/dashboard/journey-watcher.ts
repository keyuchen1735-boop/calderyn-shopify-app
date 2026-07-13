// First payload after mount is the baseline — completions that happened while
// the app was closed produce no toasts; only transitions observed live do.
export function diffNewlyDone(prev: Set<string> | null, current: string[]): string[] {
  if (!prev) return [];
  return current.filter((k) => !prev.has(k));
}
