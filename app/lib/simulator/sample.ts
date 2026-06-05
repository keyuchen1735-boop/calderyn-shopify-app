// app/lib/simulator/sample.ts
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type BehaviorModel,
  type SampleResult,
} from "./types";

/** Small fast deterministic PRNG. Same seed ⇒ same stream (stable slider + exact tests). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a → unsigned 32-bit, used to seed a run deterministically from its id. */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function sampleFunnel(model: BehaviorModel, n: number, seed: number): SampleResult {
  const rng = mulberry32(seed);
  const archetypes = model.archetypes.length
    ? model.archetypes
    : [
        {
          id: "default",
          name: "Shopper",
          weight: 1,
          // Object.fromEntries loses key typing; this asserts the funnel-keyed shape.
          advance: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 1])) as Record<
            (typeof FUNNEL_STAGES)[number],
            number
          >,
          dropReason: {},
        },
      ];
  const totalWeight = archetypes.reduce((s, a) => s + Math.max(0, a.weight), 0) || 1;

  const reached = new Array(FUNNEL_STAGES.length).fill(0);
  const dropsByStagePersona = new Map<string, number>(); // `${stageId}|${archetypeId}` -> count

  for (let i = 0; i < n; i++) {
    // pick archetype by weight
    let r = rng() * totalWeight;
    let chosen = archetypes[0];
    for (const a of archetypes) {
      r -= Math.max(0, a.weight);
      if (r <= 0) {
        chosen = a;
        break;
      }
    }
    // walk the funnel
    reached[0]++;
    for (let stageIdx = 0; stageIdx < FUNNEL_STAGES.length - 1; stageIdx++) {
      const stageId = FUNNEL_STAGES[stageIdx];
      const p = clamp01(chosen.advance?.[stageId] ?? 0);
      if (rng() < p) {
        reached[stageIdx + 1]++;
      } else {
        const key = `${stageId}|${chosen.id}`;
        dropsByStagePersona.set(key, (dropsByStagePersona.get(key) ?? 0) + 1);
        break;
      }
    }
  }

  const stages = FUNNEL_STAGES.map((id, i) => ({
    id,
    label: FUNNEL_STAGE_LABELS[id],
    reached: reached[i],
  }));

  let biggestLeak: SampleResult["biggestLeak"] = null;
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const count = reached[i] - reached[i + 1];
    if (count > 0 && (!biggestLeak || count > biggestLeak.count)) {
      biggestLeak = {
        stageId: FUNNEL_STAGES[i],
        label: FUNNEL_STAGE_LABELS[FUNNEL_STAGES[i]],
        count,
      };
    }
  }

  const findingCounts: Record<string, number> = {};
  for (const f of model.findings) {
    let c = 0;
    for (const pid of f.personaIds) {
      c += dropsByStagePersona.get(`${f.stage}|${pid}`) ?? 0;
    }
    findingCounts[f.id] = c;
  }

  return {
    n,
    stages,
    bought: reached[FUNNEL_STAGES.length - 1],
    biggestLeak,
    findingCounts,
  };
}
