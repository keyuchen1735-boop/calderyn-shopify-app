export const PRODUCT_FACT_KINDS = [
  "dimension.width", "dimension.depth", "dimension.height", "material", "compatibility",
  "ingredient", "concern", "heat_level", "document_url", "ar_model_url",
] as const;

export type ProductFactKind = (typeof PRODUCT_FACT_KINDS)[number];
export type DimensionUnit = "mm" | "cm" | "m" | "in";

export interface ProductFact {
  id: string;
  kind: ProductFactKind;
  label: string;
  value: string;
  textValue: string | null;
  numberValue: number | null;
  unit: DimensionUnit | null;
  url: string | null;
}

export interface ProductFactInput { id?: string; kind: string; value: unknown; unit?: string | null }

const DIMENSIONS = new Set<ProductFactKind>(["dimension.width", "dimension.depth", "dimension.height"]);
const TEXT_KINDS = new Set<ProductFactKind>(["material", "compatibility", "ingredient", "concern"]);
const UNITS = new Set<DimensionUnit>(["mm", "cm", "m", "in"]);
const LABELS: Record<ProductFactKind, string> = {
  "dimension.width": "Width", "dimension.depth": "Depth", "dimension.height": "Height",
  material: "Material", compatibility: "Compatibility", ingredient: "Ingredient", concern: "Concern",
  heat_level: "Heat level", document_url: "Document", ar_model_url: "AR model",
};

function safeUrl(raw: unknown, model: boolean): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("fact URL is invalid");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("fact URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("fact URL is invalid");
  if (model && !/\.(?:glb|gltf|usdz)$/i.test(url.pathname)) throw new Error("AR model URL must reference a supported model");
  return url.toString();
}

export function normalizeProductFacts(inputs: readonly ProductFactInput[]): ProductFact[] {
  if (inputs.length > 32) throw new Error("product facts exceed the public limit");
  return inputs.map((input, index) => {
    if (!PRODUCT_FACT_KINDS.includes(input.kind as ProductFactKind)) throw new Error("unsupported product fact kind");
    const kind = input.kind as ProductFactKind;
    const base = { id: input.id ?? `fact-${index}`, kind, label: LABELS[kind] };
    if (DIMENSIONS.has(kind)) {
      if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value <= 0) throw new Error("dimension value must be positive");
      if (!UNITS.has(input.unit as DimensionUnit)) throw new Error("dimension unit is invalid");
      const unit = input.unit as DimensionUnit;
      return { ...base, value: `${input.value} ${unit}`, textValue: null, numberValue: input.value, unit, url: null };
    }
    if (kind === "heat_level") {
      if (!Number.isInteger(input.value) || Number(input.value) < 0 || Number(input.value) > 5 || input.unit != null) throw new Error("heat level must be an integer from 0 to 5");
      return { ...base, value: String(input.value), textValue: null, numberValue: Number(input.value), unit: null, url: null };
    }
    if (TEXT_KINDS.has(kind)) {
      if (typeof input.value !== "string") throw new Error("fact text value is invalid");
      const textValue = input.value.normalize("NFKC").trim();
      const hasControl = [...textValue].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      });
      if (!textValue || textValue.length > 160 || hasControl) throw new Error("fact text value is invalid");
      return { ...base, value: textValue, textValue, numberValue: null, unit: null, url: null };
    }
    const url = safeUrl(input.value, kind === "ar_model_url");
    return { ...base, value: url, textValue: null, numberValue: null, unit: null, url };
  });
}

const MM: Record<DimensionUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
export function roomFit(facts: readonly ProductFact[], room: { width: number; depth: number; height: number; unit: DimensionUnit }): boolean | null {
  const dimensions = Object.fromEntries(facts.filter((fact) => DIMENSIONS.has(fact.kind)).map((fact) => [fact.kind, fact]));
  const width = dimensions["dimension.width"];
  const depth = dimensions["dimension.depth"];
  const height = dimensions["dimension.height"];
  if (!width || !depth || !height || width.numberValue == null || depth.numberValue == null || height.numberValue == null || !width.unit || !depth.unit || !height.unit) return null;
  if (![room.width, room.depth, room.height].every((value) => Number.isFinite(value) && value > 0)) return null;
  return width.numberValue * MM[width.unit] <= room.width * MM[room.unit]
    && depth.numberValue * MM[depth.unit] <= room.depth * MM[room.unit]
    && height.numberValue * MM[height.unit] <= room.height * MM[room.unit];
}

function normalized(value: string): string { return value.normalize("NFKC").trim().toLocaleLowerCase("en-US"); }
export function productCompatibility(facts: readonly ProductFact[], requested: string): boolean | null {
  const values = facts.filter((fact) => fact.kind === "compatibility" && fact.textValue).map((fact) => normalized(fact.textValue!));
  return values.length ? values.includes(normalized(requested)) : null;
}

type FactProduct = { id: string; facts: readonly ProductFact[] };
export function deriveFactFacets(products: readonly FactProduct[]): Record<string, string[]> {
  const facets = new Map<string, Set<string>>();
  for (const { facts } of products) for (const fact of facts) {
    if (!TEXT_KINDS.has(fact.kind) || !fact.textValue) continue;
    const values = facets.get(fact.kind) ?? new Set<string>();
    values.add(fact.textValue); facets.set(fact.kind, values);
  }
  return Object.fromEntries([...facets].sort(([a], [b]) => a.localeCompare(b)).map(([kind, values]) => [kind, [...values].sort()]));
}

export function filterProductsByFacts<T extends FactProduct>(products: readonly T[], filters: Readonly<Record<string, string>>): T[] {
  return products.filter(({ facts }) => Object.entries(filters).every(([kind, value]) =>
    facts.some((fact) => fact.kind === kind && fact.textValue != null && normalized(fact.textValue) === normalized(value))));
}
