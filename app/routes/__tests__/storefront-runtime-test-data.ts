export function requireLegacyLoaderData<T>(value: T): Exclude<T, { runtime: 1 }> {
  if (value && typeof value === "object" && "runtime" in value && value.runtime === 1) {
    throw new Error("Expected the runtime-0 loader branch");
  }
  return value as Exclude<T, { runtime: 1 }>;
}
