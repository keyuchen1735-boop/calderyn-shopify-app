import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  loadStudioState,
  saveStudioHero,
  saveStudioAccent,
  saveStudioVibe,
  publishStudioStore,
} from "~/lib/storebuilder/studio.server";
import { decideExperiment, startExperiment } from "~/lib/experiments/store-experiment.server";
import { generateStore } from "~/lib/storegen/generate.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";
import { quotaTrusted } from "~/lib/ai-quota.server";

// Store studio read model: brand settings, home hero copy, preview products,
// draft/published flags, and the latest generation run.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadStudioState(session.shopId));
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HERO_TEXT_MAX = 300;
const STUDIO_VIBES: readonly string[] = ["minimal", "bold", "warm"];
const EXPERIMENT_KINDS: readonly string[] = ["headline", "vibe"];
const EXPERIMENT_DECISIONS: readonly string[] = ["ship", "keep", "stop"];
const EXPERIMENT_NAME_MAX = 80;

function heroText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length <= HERO_TEXT_MAX ? t : null;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, "invalid_json");
  }
  if (typeof body !== "object" || body === null) return jsonError(422, "invalid_body");
  const b = body as Record<string, unknown>;

  switch (b.action) {
    case "save-hero": {
      const headline = heroText(b.headline);
      const subhead = heroText(b.subhead);
      if (headline == null || subhead == null || headline === "") {
        return jsonError(422, "invalid_hero", "Hero copy must be text (headline non-empty, 300 chars max).");
      }
      return dashboardJson(async () => ({
        hero: await saveStudioHero(session.shopId, { headline, subhead }),
      }));
    }

    case "accent": {
      const color = typeof b.color === "string" ? b.color : "";
      if (!HEX_COLOR_RE.test(color)) {
        return jsonError(422, "invalid_color", "Accent must be a #rrggbb hex color.");
      }
      return dashboardJson(async () => {
        await saveStudioAccent(session.shopId, color);
        return { accent: color };
      });
    }

    case "generate": {
      if (b.brief !== undefined && typeof b.brief !== "string") {
        return jsonError(422, "invalid_brief");
      }
      const rawBrief = typeof b.brief === "string" ? b.brief : undefined;
      return dashboardJson(async () => {
        // Brief cap, burst limit, mid-test refusal AND the daily AI quota are
        // shared with dashboard.builder.generate.tsx (guard.server.ts) — one
        // shop gets one coherent budget across both paid entry points.
        await assertCanGenerate(session.shopId, rawBrief, { trusted: quotaTrusted(session) });
        const brief = rawBrief && rawBrief.trim() ? rawBrief.trim() : undefined;
        try {
          // Real generation — can take several seconds; awaited deliberately.
          const result = await generateStore({
            shopId: session.shopId,
            mode: brief ? "brief" : "catalog",
            brief,
          });
          return { runId: result.runId, status: result.status };
        } catch (err) {
          console.error("[dashboard.api.store] store generation failed", err);
          throw new CalderynError({
            code: "generation_failed",
            status: 502,
            message: "Store generation failed. Please try again.",
          });
        }
      });
    }

    case "publish": {
      return dashboardJson(async () => {
        await publishStudioStore(session.shopId);
        return { publishedAt: new Date().toISOString() };
      });
    }

    case "vibe": {
      const vibe = typeof b.vibe === "string" ? b.vibe : "";
      if (!STUDIO_VIBES.includes(vibe)) {
        return jsonError(422, "invalid_vibe", "Vibe must be minimal, bold or warm.");
      }
      return dashboardJson(async () => {
        await saveStudioVibe(session.shopId, vibe as StudioVibe);
        return { vibe };
      });
    }

    case "experiment-start": {
      // Starting a test writes a row and reads the catalog; cap per shop to
      // bound abuse the same way generate does.
      if (!(await rateLimit(`experiment:${session.shopId}`, 10, 60_000))) {
        return jsonError(429, "rate_limited", "Too many experiment starts. Please wait a moment.");
      }
      const kind = typeof b.kind === "string" ? b.kind : "";
      if (!EXPERIMENT_KINDS.includes(kind)) {
        return jsonError(422, "invalid_kind", "Experiment kind must be headline or vibe.");
      }
      if (b.name !== undefined && typeof b.name !== "string") {
        return jsonError(422, "invalid_name");
      }
      const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
      if (name && name.length > EXPERIMENT_NAME_MAX) {
        return jsonError(422, "invalid_name", "Keep the test name under 80 characters.");
      }
      return dashboardJson(async () => ({
        experiment: await startExperiment(session.shopId, {
          kind: kind as "headline" | "vibe",
          name,
        }),
      }));
    }

    case "experiment-decide": {
      const id = typeof b.id === "string" ? b.id : "";
      if (!isUuid(id)) return jsonError(422, "invalid_id");
      const decision = typeof b.decision === "string" ? b.decision : "";
      if (!EXPERIMENT_DECISIONS.includes(decision)) {
        return jsonError(422, "invalid_decision", "Decision must be ship, keep or stop.");
      }
      return dashboardJson(async () => ({
        experiment: await decideExperiment(session.shopId, id, decision as "ship" | "keep" | "stop"),
      }));
    }

    default:
      return jsonError(422, "unknown_action");
  }
}
