import type { InteractionManifestV1 } from "~/lib/storefront-bundle/types";

export type RuntimeStateValue = boolean | string | number;
export type RuntimeState = Readonly<Record<string, RuntimeStateValue>>;

export type RuntimeStateUpdate =
  | { type: "set"; stateId: string; value: unknown }
  | { type: "increment" | "decrement"; stateId: string };

type StateDefinition = InteractionManifestV1["state"][number];

export class RuntimeManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeManifestError";
  }
}

export function isCompilerIssuedId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 160 || !value.startsWith("cd-")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      character === "-" ||
      character === "_";
    if (!allowed) return false;
  }
  return true;
}

function assertFiniteBounds(definition: StateDefinition): asserts definition is StateDefinition & {
  min: number;
  max: number;
} {
  if (!Number.isFinite(definition.min) || !Number.isFinite(definition.max) || definition.max! < definition.min!) {
    throw new RuntimeManifestError(`State ${definition.id} has invalid bounds`);
  }
  if (definition.max! - definition.min! > 10_000) {
    throw new RuntimeManifestError(`State ${definition.id} exceeds the runtime bound`);
  }
}

function assertValue(definition: StateDefinition, value: unknown): asserts value is RuntimeStateValue {
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") throw new RuntimeManifestError(`State ${definition.id} requires a boolean`);
    return;
  }
  if (definition.type === "enum") {
    if (!Array.isArray(definition.allowedValues) || definition.allowedValues.length < 2 || definition.allowedValues.length > 32) {
      throw new RuntimeManifestError(`State ${definition.id} has an invalid enum allowlist`);
    }
    if (typeof value !== "string" || !definition.allowedValues.includes(value)) {
      throw new RuntimeManifestError(`State ${definition.id} rejects enum value`);
    }
    return;
  }
  if (definition.type === "textQuery") {
    if (typeof value !== "string" || value.length > 200) {
      throw new RuntimeManifestError(`State ${definition.id} exceeds the query bound`);
    }
    return;
  }
  assertFiniteBounds(definition);
  if (typeof value !== "number" || !Number.isFinite(value) || value < definition.min || value > definition.max) {
    throw new RuntimeManifestError(`State ${definition.id} rejects numeric value`);
  }
  if (definition.type === "index" && !Number.isSafeInteger(value)) {
    throw new RuntimeManifestError(`State ${definition.id} requires a safe integer`);
  }
}

function definitions(manifest: InteractionManifestV1): Map<string, StateDefinition> {
  if (manifest.version !== 1 || !Array.isArray(manifest.state) || manifest.state.length > 128) {
    throw new RuntimeManifestError("Interaction state manifest is unsupported or exceeds its bound");
  }
  const result = new Map<string, StateDefinition>();
  for (const definition of manifest.state) {
    if (!isCompilerIssuedId(definition.id) || result.has(definition.id)) {
      throw new RuntimeManifestError(`State ID ${JSON.stringify(definition.id)} is not compiler-issued and unique`);
    }
    assertValue(definition, definition.initial);
    result.set(definition.id, definition);
  }
  return result;
}

export function createInitialRuntimeState(manifest: InteractionManifestV1): RuntimeState {
  const initial: Record<string, RuntimeStateValue> = {};
  for (const definition of definitions(manifest).values()) initial[definition.id] = definition.initial;
  return Object.freeze(initial);
}

export function reduceRuntimeState(
  manifest: InteractionManifestV1,
  current: RuntimeState,
  update: RuntimeStateUpdate,
): RuntimeState {
  const definition = definitions(manifest).get(update.stateId);
  if (!definition) throw new RuntimeManifestError(`Unknown state ${JSON.stringify(update.stateId)}`);
  let nextValue: unknown;
  if (update.type === "set") {
    nextValue = update.value;
  } else {
    if (definition.type !== "boundedNumber" && definition.type !== "index") {
      throw new RuntimeManifestError(`${update.type} requires bounded numeric state`);
    }
    assertFiniteBounds(definition);
    const currentValue = current[update.stateId];
    if (typeof currentValue !== "number" || !Number.isFinite(currentValue)) {
      throw new RuntimeManifestError(`Current state ${update.stateId} is invalid`);
    }
    const delta = update.type === "increment" ? 1 : -1;
    nextValue = Math.min(definition.max, Math.max(definition.min, currentValue + delta));
  }
  assertValue(definition, nextValue);
  if (current[update.stateId] === nextValue) return current;
  return Object.freeze({ ...current, [update.stateId]: nextValue });
}

export function runtimeStateDefinition(
  manifest: InteractionManifestV1,
  stateId: string,
): StateDefinition | undefined {
  return definitions(manifest).get(stateId);
}
