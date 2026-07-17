export function requireLegacyLoaderData<T>(value: T): Exclude<T, { runtime: 1 } | { designer: true }> {
  if (value && typeof value === "object" && "runtime" in value && value.runtime === 1) {
    throw new Error("Expected the runtime-0 loader branch");
  }
  if (value && typeof value === "object" && "designer" in value && value.designer === true) {
    throw new Error("Expected the runtime-0 loader branch, got a designer publication");
  }
  return value as Exclude<T, { runtime: 1 } | { designer: true }>;
}
