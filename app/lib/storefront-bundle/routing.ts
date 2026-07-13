import { isStoreTemplateId } from "./registry";
import type {
  CatalogRoutingEvidence,
  CatalogRoutingField,
  RoutingScoreBreakdown,
  StoreDesignRequest,
  StoreDesignResolution,
  StoreTemplateId,
  VersionedStoreTemplate,
  VersionedStoreTemplateRegistry,
} from "./types";

const MAX_PROMPT_CODE_POINTS = 4_000;
const MIN_PROMPT_SCORE = 6;
const MIN_CATALOG_SCORE = 4;
const MIN_MARGIN = 2;

export function normalizeRoutingText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[’‘`]/g, "'")
    .replace(/[\p{Pd}-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function grammarText(value: string): string {
  return normalizeRoutingText(value).replace(/\bdon't\b/g, "do not");
}

function tokens(value: string): string[] {
  return grammarText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export type StoreDesignRequestParseResult =
  | { ok: true; value: StoreDesignRequest }
  | { ok: false; error: "invalid_design_request" };

export function parseStoreDesignRequest(
  input: unknown,
  registry: VersionedStoreTemplateRegistry,
): StoreDesignRequestParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_design_request" };
  const body = input as Record<string, unknown>;
  if (typeof body.prompt !== "string" || !["auto", "recipe", "custom"].includes(String(body.mode))) {
    return { ok: false, error: "invalid_design_request" };
  }
  const prompt = body.prompt.trim();
  if (Array.from(prompt).length > MAX_PROMPT_CODE_POINTS) return { ok: false, error: "invalid_design_request" };
  const mode = body.mode as StoreDesignRequest["mode"];
  const templateId = body.templateId;
  const registryIds = new Set(registry.templates.map((template) => template.id));
  if (mode === "recipe") {
    if (!isStoreTemplateId(templateId) || !registryIds.has(templateId)) return { ok: false, error: "invalid_design_request" };
    return { ok: true, value: { prompt, mode, templateId } };
  }
  if (templateId !== undefined || (mode === "custom" && !prompt)) return { ok: false, error: "invalid_design_request" };
  return { ok: true, value: { prompt, mode } };
}

interface Span {
  start: number;
  end: number;
  phrase: string;
}

function findPhraseSpans(haystack: string[], phrase: string): Span[] {
  const needle = tokens(phrase);
  if (!needle.length || needle.length > haystack.length) return [];
  const spans: Span[] = [];
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((token, offset) => haystack[index + offset] === token)) {
      spans.push({ start: index, end: index + needle.length, phrase: normalizeRoutingText(phrase) });
    }
  }
  return spans;
}

function nonOverlappingPhraseSpans(haystack: string[], phrases: readonly string[]): Span[] {
  const candidates = phrases
    .flatMap((phrase) => findPhraseSpans(haystack, phrase))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.phrase.localeCompare(b.phrase));
  const consumed = new Set<number>();
  const selected: Span[] = [];
  for (const candidate of candidates) {
    let overlaps = false;
    for (let index = candidate.start; index < candidate.end; index += 1) {
      if (consumed.has(index)) overlaps = true;
    }
    if (overlaps) continue;
    selected.push(candidate);
    for (let index = candidate.start; index < candidate.end; index += 1) consumed.add(index);
  }
  return selected.sort((a, b) => a.start - b.start);
}

function phraseWithin(tokensToSearch: string[], start: number, maxGap: number, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    const phraseTokens = tokens(phrase);
    for (let index = start; index <= Math.min(tokensToSearch.length - phraseTokens.length, start + maxGap); index += 1) {
      if (phraseTokens.every((token, offset) => tokensToSearch[index + offset] === token)) return true;
    }
  }
  return false;
}

function hasExplicitCustomIntent(prompt: string): boolean {
  const clauses = grammarText(prompt).split(/[;.!?\n]+/u).filter(Boolean);
  const originality = ["from scratch", "completely new", "entirely new", "entirely original", "completely original"];
  const imperatives = new Set(["build", "design", "create", "make"]);
  const designNouns = new Set(["store", "site", "theme", "layout"]);

  for (const clause of clauses) {
    const clauseTokens = tokens(clause);
    const standaloneOffset = clauseTokens[1] === "me" || clauseTokens[1] === "us" ? 2 : 1;
    if (
      imperatives.has(clauseTokens[0]) &&
      clauseTokens.length === standaloneOffset + 3 &&
      clauseTokens[standaloneOffset] === "something" &&
      ((clauseTokens[standaloneOffset + 1] === "completely" && clauseTokens[standaloneOffset + 2] === "new") ||
        (clauseTokens[standaloneOffset + 1] === "entirely" && clauseTokens[standaloneOffset + 2] === "original"))
    ) return true;
    for (let index = 0; index < clauseTokens.length; index += 1) {
      const token = clauseTokens[index];
      if ((token === "no" || token === "without") && phraseWithin(clauseTokens, index + 1, 3, ["template", "theme"])) return true;
      if (token === "avoid" || (token === "do" && clauseTokens[index + 1] === "not")) {
        const afterNegative = token === "avoid" ? index + 1 : index + 2;
        const noTemplateWindow = clauseTokens.slice(afterNegative, afterNegative + 4);
        const verbIndex = noTemplateWindow.findIndex((candidate) => candidate === "use" || candidate === "apply");
        if (
          verbIndex >= 0 &&
          noTemplateWindow.slice(verbIndex + 1).some((candidate) => candidate === "template" || candidate === "theme")
        ) {
          return true;
        }
      }
      if (!imperatives.has(token)) continue;
      const before = clauseTokens.slice(Math.max(0, index - 3), index);
      if (before.includes("not") || before.includes("avoid")) continue;

      const nounIndexes: number[] = [];
      for (let cursor = Math.max(0, index - 5); cursor <= Math.min(clauseTokens.length - 1, index + 5); cursor += 1) {
        if (designNouns.has(clauseTokens[cursor])) nounIndexes.push(cursor);
      }
      for (const nounIndex of nounIndexes) {
        if (phraseWithin(clauseTokens, nounIndex + 1, 4, originality)) return true;
        for (const originalPhrase of originality) {
          for (const span of findPhraseSpans(clauseTokens, originalPhrase)) {
            if (span.end <= nounIndex && nounIndex - span.end <= 4) return true;
          }
        }
      }
    }
  }
  return false;
}

function isNegativeNameSpan(promptTokens: string[], span: Span): boolean {
  const preceding = promptTokens.slice(Math.max(0, span.start - 4), span.start);
  const last = preceding[preceding.length - 1];
  if (last === "not" || last === "avoid" || last === "without") return true;
  const governor = preceding[preceding.length - 2];
  const governedVerbs = new Set([
    "use", "using", "apply", "applying", "pick", "picking", "choose", "choosing", "select", "selecting", "try", "trying",
  ]);
  if (governedVerbs.has(last) && (governor === "not" || governor === "avoid" || governor === "without")) {
    return true;
  }
  const priorGovernor = preceding[preceding.length - 3];
  if ((last === "a" || last === "the") && governedVerbs.has(governor) && (priorGovernor === "not" || priorGovernor === "avoid" || priorGovernor === "without")) return true;
  return false;
}

interface ExplicitNameHit {
  templateId: StoreTemplateId;
  phrase: string;
}

function explicitRecipeNames(prompt: string, registry: VersionedStoreTemplateRegistry): ExplicitNameHit[] {
  const promptTokens = tokens(prompt);
  const candidates = registry.templates.flatMap((template) =>
    [template.name, ...template.aliases].flatMap((phrase) =>
      findPhraseSpans(promptTokens, phrase).map((span) => ({ ...span, templateId: template.id })),
    ),
  );
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.templateId.localeCompare(b.templateId));
  const consumed = new Set<number>();
  const hits: ExplicitNameHit[] = [];
  for (const candidate of candidates) {
    let overlaps = false;
    for (let index = candidate.start; index < candidate.end; index += 1) if (consumed.has(index)) overlaps = true;
    if (overlaps) continue;
    for (let index = candidate.start; index < candidate.end; index += 1) consumed.add(index);
    if (!isNegativeNameSpan(promptTokens, candidate)) hits.push({ templateId: candidate.templateId, phrase: candidate.phrase });
  }
  return hits.filter((hit, index) => hits.findIndex((candidate) => candidate.templateId === hit.templateId) === index);
}

function catalogMatches(
  template: VersionedStoreTemplate,
  evidence: CatalogRoutingEvidence,
): Array<{ term: string; field: CatalogRoutingField }> {
  const fields: CatalogRoutingField[] = ["productTitles", "productTypes", "productTags", "optionNames", "collectionTitles"];
  const matches: Array<{ term: string; field: CatalogRoutingField }> = [];
  const pairs = new Set<string>();
  for (const field of fields) {
    for (const value of evidence[field]) {
      for (const span of nonOverlappingPhraseSpans(tokens(value), template.catalogTerms)) {
        const key = `${field}\u0000${span.phrase}`;
        if (!pairs.has(key)) {
          pairs.add(key);
          matches.push({ term: span.phrase, field });
        }
      }
    }
  }
  return matches.sort((a, b) => a.field.localeCompare(b.field) || a.term.localeCompare(b.term));
}

function scoreTemplate(
  template: VersionedStoreTemplate,
  prompt: string,
  evidence: CatalogRoutingEvidence,
  nameHits: ExplicitNameHit[],
): RoutingScoreBreakdown {
  const promptTokens = tokens(prompt);
  const aliasHits = nameHits.filter((hit) => hit.templateId === template.id).map((hit) => hit.phrase);
  const strongSpans = nonOverlappingPhraseSpans(promptTokens, template.strongPhrases);
  const consumed = new Set(strongSpans.flatMap((span) => Array.from({ length: span.end - span.start }, (_, offset) => span.start + offset)));
  const promptTermHits = nonOverlappingPhraseSpans(promptTokens, template.promptTerms)
    .filter((span) => {
      for (let index = span.start; index < span.end; index += 1) if (consumed.has(index)) return false;
      return true;
    })
    .map((span) => span.phrase)
    .filter((term, index, all) => all.indexOf(term) === index);
  const catalogTermHits = catalogMatches(template, evidence);
  const distinctCatalogTerms = new Set(catalogTermHits.map((hit) => hit.term));
  return {
    templateId: template.id,
    aliasHits,
    strongPhraseHits: strongSpans.map((span) => span.phrase).filter((term, index, all) => all.indexOf(term) === index),
    promptTermHits,
    catalogTermHits,
    score: aliasHits.length * 100 + strongSpans.filter((span, index, all) => all.findIndex((other) => other.phrase === span.phrase) === index).length * 6 + promptTermHits.length * 3 + Math.min(6, distinctCatalogTerms.size),
  };
}

function metadata(registry: VersionedStoreTemplateRegistry, evidence: CatalogRoutingEvidence) {
  return {
    routingVersion: registry.routingVersion,
    registryVersion: registry.registryVersion,
    catalogFingerprint: evidence.fingerprint,
  };
}

function custom(
  reason: Extract<StoreDesignResolution, { kind: "custom" }>["reason"],
  registry: VersionedStoreTemplateRegistry,
  evidence: CatalogRoutingEvidence,
  breakdown: RoutingScoreBreakdown[],
  reasons: string[],
): StoreDesignResolution {
  return { kind: "custom", reason, ...metadata(registry, evidence), breakdown, reasons };
}

export function resolveStoreDesign(
  request: StoreDesignRequest,
  evidence: CatalogRoutingEvidence,
  registry: VersionedStoreTemplateRegistry,
): StoreDesignResolution {
  if (request.mode === "recipe") {
    const template = registry.templates.find((candidate) => candidate.id === request.templateId);
    if (!template) throw new Error(`Template ${String(request.templateId)} is not present in the supplied registry`);
    return {
      kind: "recipe",
      templateId: template.id,
      templateVersion: template.activeVersion,
      selectionKind: "manual_override",
      ...metadata(registry, evidence),
      score: null,
      runnerUpScore: null,
      margin: null,
      confidenceBand: null,
      breakdown: [],
      reasons: [`Selected ${template.name}`],
    };
  }
  if (request.mode === "custom") return custom("manual_override", registry, evidence, [], ["Selected original design"]);

  const nameHits = explicitRecipeNames(request.prompt, registry);
  const breakdown = registry.templates.map((template) => scoreTemplate(template, request.prompt, evidence, nameHits));
  if (hasExplicitCustomIntent(request.prompt)) {
    return custom("explicit_custom", registry, evidence, breakdown, ["Prompt explicitly requests an original design"]);
  }
  if (nameHits.length > 1) {
    return custom("ambiguous_recipe_names", registry, evidence, breakdown, ["Prompt names more than one recipe"]);
  }

  const ranked = breakdown
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index);
  const winner = ranked[0]?.entry;
  const runnerUpScore = ranked[1]?.entry.score ?? 0;
  if (!winner) return custom("low_confidence", registry, evidence, breakdown, ["No recipe matched"]);
  const template = registry.templates.find((candidate) => candidate.id === winner.templateId)!;
  const margin = winner.score - runnerUpScore;

  if (nameHits.length === 1) {
    return {
      kind: "recipe",
      templateId: template.id,
      templateVersion: template.activeVersion,
      selectionKind: "explicit_name",
      ...metadata(registry, evidence),
      score: winner.score,
      runnerUpScore,
      margin,
      confidenceBand: "high",
      breakdown,
      reasons: [`Prompt names ${template.name}`],
    };
  }

  const promptIsEmpty = normalizeRoutingText(request.prompt).length === 0;
  if (promptIsEmpty) {
    const fields = new Set(winner.catalogTermHits.map((hit) => hit.field));
    if (winner.score < MIN_CATALOG_SCORE || margin < MIN_MARGIN || fields.size < 2) {
      return custom("low_confidence", registry, evidence, breakdown, ["Catalog evidence is not specific enough"]);
    }
  } else {
    const promptStrongSignal = winner.strongPhraseHits.length > 0 || winner.promptTermHits.length >= 2 || winner.aliasHits.length > 0;
    if (winner.score < MIN_PROMPT_SCORE || margin < MIN_MARGIN || !promptStrongSignal) {
      return custom("low_confidence", registry, evidence, breakdown, ["Prompt does not confidently match one recipe"]);
    }
  }

  const promptReason = winner.strongPhraseHits.length
    ? `Prompt matches ${winner.strongPhraseHits.join(", ")}`
    : `Prompt terms match ${template.niche}`;
  const catalogReason = winner.catalogTermHits.length ? `Catalog supports ${template.niche}` : null;
  return {
    kind: "recipe",
    templateId: template.id,
    templateVersion: template.activeVersion,
    selectionKind: "niche_match",
    ...metadata(registry, evidence),
    score: winner.score,
    runnerUpScore,
    margin,
    confidenceBand: winner.score >= 9 && margin >= 4 ? "high" : "medium",
    breakdown,
    reasons: [promptReason, ...(catalogReason ? [catalogReason] : [])],
  };
}
