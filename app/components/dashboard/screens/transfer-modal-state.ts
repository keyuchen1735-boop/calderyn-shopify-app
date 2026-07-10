// Pure validation for the stock-move modal, framework-free so the rules are
// unit-testable without rendering the dialog. `availableAtSource` is null when
// the per-location balance hasn't loaded (or failed to) — validation passes
// that through and the server still enforces stock on submit.
export function transferValidation(
  from: string,
  to: string,
  qty: number,
  availableAtSource: number | null,
): string | null {
  if (!from || !to) return "Pick both locations.";
  if (from === to) return "Pick two different locations.";
  if (!Number.isFinite(qty) || qty < 1) return "Quantity must be at least 1.";
  if (availableAtSource != null && qty > availableAtSource) {
    return `Only ${availableAtSource} available at the source location.`;
  }
  return null;
}
