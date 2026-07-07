// Deterministic text helpers shared by the writer. Pure and framework-free.
export function plainText(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function clampText(input: string, max: number): string {
  const s = input.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

export function clampTitle(title: string, storeName: string, max = 60): string {
  const full = `${title} · ${storeName}`;
  if (full.length <= max) return full;
  return clampText(title, max);
}
