import type {
  CandidateJudgment,
  ExploredConcept,
  JudgeScores,
  MerchantStorefrontContext,
  NoveltySignature,
  ConceptRenderEvidence,
  StorefrontAiProvider,
  StructuredModelResponse,
} from "./contracts";
import { COMPILER_SYSTEM_PROMPT, JUDGE_SCHEMA, judgePrompt } from "./prompts";

const AXES: readonly (keyof NoveltySignature)[] = [
  "layoutTopology", "typeTreatment", "sectionSequence", "navigationModel", "interactionStyle",
];

export interface NoveltyResult {
  score: number;
  minimumDifferentAxes: number;
  closestTemplateId: string | null;
  passed: boolean;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function calculateNovelty(
  signature: NoveltySignature,
  recipes: MerchantStorefrontContext["recipeNoveltySignatures"],
): NoveltyResult {
  if (!recipes.length) return { score: 100, minimumDifferentAxes: 5, closestTemplateId: null, passed: true };
  let closest = { templateId: "", different: AXES.length };
  for (const recipe of recipes) {
    const different = AXES.filter((axis) => normalized(signature[axis]) !== normalized(recipe.signature[axis])).length;
    if (different < closest.different) closest = { templateId: recipe.templateId, different };
  }
  const score = closest.different * 20;
  return {
    score,
    minimumDifferentAxes: closest.different,
    closestTemplateId: closest.templateId,
    passed: closest.different >= 3 && score >= 75,
  };
}

function parseJudge(value: unknown): { scores: JudgeScores; rationale: string } {
  if (!value || typeof value !== "object") throw new Error("Judge output must be an object");
  const object = value as Record<string, unknown>;
  if (!object.scores || typeof object.scores !== "object") throw new Error("Judge scores are required");
  const raw = object.scores as Record<string, unknown>;
  const keys: readonly (keyof JudgeScores)[] = [
    "promptFit", "ecommerceClarity", "hierarchy", "responsiveQuality", "interactionClarity", "typographyImagery", "accessibility", "originality",
  ];
  const scores = Object.fromEntries(keys.map((key) => {
    const number = Number(raw[key]);
    if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error(`Judge score ${key} is invalid`);
    return [key, number];
  })) as unknown as JudgeScores;
  if (typeof object.rationale !== "string") throw new Error("Judge rationale is invalid");
  return { scores, rationale: object.rationale.slice(0, 2_000) };
}

export interface RankConceptsInput {
  candidates: ExploredConcept[];
  context: MerchantStorefrontContext;
  provider: StorefrontAiProvider;
  render(input: { candidate: ExploredConcept; context: MerchantStorefrontContext; signal?: AbortSignal }): Promise<ConceptRenderEvidence>;
  signal?: AbortSignal;
  onModelCall?: (operation: "judge", response: StructuredModelResponse) => void;
}

export interface RankConceptsResult {
  accepted: CandidateJudgment[];
  rejected: Array<{ candidate: ExploredConcept; reason: string; judgment?: CandidateJudgment }>;
}

export async function rankConcepts(input: RankConceptsInput): Promise<RankConceptsResult> {
  const results = await Promise.all(input.candidates.map(async (candidate) => {
    const novelty = calculateNovelty(candidate.structuralSignature, input.context.recipeNoveltySignatures);
    if (!novelty.passed) return { rejected: { candidate, reason: `novelty gate failed (${novelty.score})` } };
    try {
      const renders = await input.render({ candidate, context: input.context, signal: input.signal });
      const response = await input.provider.complete({
        operation: "judge",
        system: COMPILER_SYSTEM_PROMPT,
        prompt: judgePrompt(candidate, input.context),
        schema: JUDGE_SCHEMA,
        images: [renders.desktop, renders.desktopCatalog, renders.mobile, renders.mobileCatalog],
        signal: input.signal,
      });
      input.onModelCall?.("judge", response);
      const parsed = parseJudge(response.value);
      const values = Object.values(parsed.scores);
      const overall = values.reduce((sum, score) => sum + score, 0) / values.length;
      const judgment: CandidateJudgment = {
        candidate,
        scores: parsed.scores,
        overall,
        noveltyScore: novelty.score,
        rationale: parsed.rationale,
      };
      if (overall < 80 || values.some((score) => score < 70)) {
        return { rejected: { candidate, reason: `visual quality gate failed (${overall.toFixed(1)})`, judgment } };
      }
      return { accepted: judgment };
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && (error.name === "GenerationBudgetError" || error.name === "AbortError"))) throw error;
      return { rejected: { candidate, reason: error instanceof Error ? error.message : String(error) } };
    }
  }));
  return {
    accepted: results.flatMap((result) => result.accepted ? [result.accepted] : [])
      .sort((a, b) => b.overall - a.overall || b.noveltyScore - a.noveltyScore || a.candidate.candidate.candidateId.localeCompare(b.candidate.candidate.candidateId)),
    rejected: results.flatMap((result) => result.rejected ? [result.rejected] : []),
  };
}
