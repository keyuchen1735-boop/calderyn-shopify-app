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

const MIN_PROMPT_SCORE = 6;
const MIN_CATALOG_SCORE = 4;
const MIN_MARGIN = 2;
const NEGATION_FOCUS_WORDS = new Set(["only", "just", "merely", "exclusively", "simply"]);
const NEGATION_NAME_DETERMINERS = new Set(["a", "an", "the", "either", "neither"]);
const NEGATION_COORDINATORS = new Set(["and", "or", "nor"]);

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

function isNegativeNameSpan(promptTokens: string[], span: Span): boolean {
  const preceding = promptTokens.slice(Math.max(0, span.start - 4), span.start);
  const last = preceding[preceding.length - 1];
  if (last === "not" || last === "avoid" || last === "without" || last === "neither") return true;
  const governor = preceding[preceding.length - 2];
  if (governor === "not" && last && NEGATION_FOCUS_WORDS.has(last)) return false;
  if (last && (governor === "not" || governor === "avoid" || governor === "without")) {
    return true;
  }
  const priorGovernor = preceding[preceding.length - 3];
  if (
    priorGovernor === "not" &&
    governor &&
    NEGATION_FOCUS_WORDS.has(governor) &&
    last && NEGATION_NAME_DETERMINERS.has(last)
  ) return false;
  if (last && NEGATION_NAME_DETERMINERS.has(last)
    && governor
    && (priorGovernor === "not" || priorGovernor === "avoid" || priorGovernor === "without")) return true;
  return false;
}

function continuesNegativeNameList(between: string[]): boolean {
  if (between.length === 0) return true;
  return between.some((token) => NEGATION_COORDINATORS.has(token))
    && between.every((token) => NEGATION_COORDINATORS.has(token) || NEGATION_NAME_DETERMINERS.has(token));
}

interface ExplicitNameHit {
  templateId: StoreTemplateId;
  phrase: string;
}

function recipeNameHits(prompt: string, registry: VersionedStoreTemplateRegistry): {
  positive: ExplicitNameHit[];
  negative: StoreTemplateId[];
} {
  const positive: ExplicitNameHit[] = [];
  const negative: StoreTemplateId[] = [];
  const clauses = grammarText(prompt).split(/[;.!?\n]+/u).filter(Boolean);
  for (const clause of clauses) {
    const clauseTokens = tokens(clause);
    const candidates = registry.templates.flatMap((template) =>
      [template.name, ...template.aliases].flatMap((phrase) =>
        findPhraseSpans(clauseTokens, phrase).map((span) => ({ ...span, templateId: template.id })),
      ),
    );
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.templateId.localeCompare(b.templateId));
    const consumed = new Set<number>();
    const selected: typeof candidates = [];
    for (const candidate of candidates) {
      let overlaps = false;
      for (let index = candidate.start; index < candidate.end; index += 1) if (consumed.has(index)) overlaps = true;
      if (overlaps) continue;
      for (let index = candidate.start; index < candidate.end; index += 1) consumed.add(index);
      selected.push(candidate);
    }
    selected.sort((a, b) => a.start - b.start);
    let priorNegative = false;
    let priorEnd = 0;
    for (const candidate of selected) {
      const between = clauseTokens.slice(priorEnd, candidate.start);
      const isNegative: boolean = isNegativeNameSpan(clauseTokens, candidate)
        || (priorNegative && continuesNegativeNameList(between));
      if (isNegative) negative.push(candidate.templateId);
      else positive.push({ templateId: candidate.templateId, phrase: candidate.phrase });
      priorNegative = isNegative;
      priorEnd = candidate.end;
    }
  }
  return {
    positive: positive.filter((hit, index) => positive.findIndex((candidate) => candidate.templateId === hit.templateId) === index),
    negative: negative.filter((templateId, index) => negative.indexOf(templateId) === index),
  };
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

function noMatch(
  registry: VersionedStoreTemplateRegistry,
  evidence: CatalogRoutingEvidence,
): StoreDesignResolution {
  return {
    kind: "no_match",
    reason: "all_designs_excluded",
    ...metadata(registry, evidence),
    breakdown: [],
    reasons: ["No approved design remains after exclusions"],
  };
}

export function resolveStoreDesign(
  request: StoreDesignRequest,
  evidence: CatalogRoutingEvidence,
  registry: VersionedStoreTemplateRegistry,
): StoreDesignResolution {
  const nameHits = recipeNameHits(request.prompt, registry);
  const excluded = new Set([...(request.excludedTemplateIds ?? []), ...nameHits.negative]);
  const eligibleRegistry = {
    ...registry,
    templates: registry.templates.filter(({ id }) => !excluded.has(id)),
  };
  if (eligibleRegistry.templates.length === 0) return noMatch(registry, evidence);
  const positiveNameHits = nameHits.positive.filter(({ templateId }) => !excluded.has(templateId));
  const breakdown = eligibleRegistry.templates.map((template) => scoreTemplate(template, request.prompt, evidence, positiveNameHits));
  const ranked = breakdown
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index);
  const winner = ranked[0]?.entry;
  const runnerUpScore = ranked[1]?.entry.score ?? 0;
  if (!winner) return noMatch(registry, evidence);
  const template = eligibleRegistry.templates.find((candidate) => candidate.id === winner.templateId)!;
  const margin = winner.score - runnerUpScore;

  if (positiveNameHits.length === 1) {
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
  const catalogFields = new Set(winner.catalogTermHits.map((hit) => hit.field));
  const promptStrongSignal = winner.strongPhraseHits.length > 0 || winner.promptTermHits.length >= 2 || winner.aliasHits.length > 0;
  const lowConfidence = promptIsEmpty
    ? winner.score < MIN_CATALOG_SCORE || margin < MIN_MARGIN || catalogFields.size < 2
    : winner.score < MIN_PROMPT_SCORE || margin < MIN_MARGIN || !promptStrongSignal;
  if (lowConfidence) {
    return {
      kind: "recipe",
      templateId: template.id,
      templateVersion: template.activeVersion,
      selectionKind: "niche_match",
      ...metadata(registry, evidence),
      score: winner.score,
      runnerUpScore,
      margin,
      confidenceBand: null,
      breakdown,
      reasons: [`Using the closest complete recipe for ${template.niche}`],
    };
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
