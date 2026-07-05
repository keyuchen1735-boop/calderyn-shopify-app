import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, jsonOk, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  loadStudioState,
  saveStudioHero,
  saveStudioAccent,
  publishStudioStore,
} from "~/lib/storebuilder/studio.server";
import { generateStore } from "~/lib/storegen/generate.server";
import { checkAiQuota, quotaTrusted } from "~/lib/ai-quota.server";

// Store studio read model: brand settings, home hero copy, preview products,
// draft/published flags, and the latest generation run.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadStudioState(session.shopId));
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HERO_TEXT_MAX = 300;
// A brief is a short prompt, not a document; the cap bounds LLM input spend
// (the brief is interpolated into several generation prompts per run).
const BRIEF_MAX = 4000;

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
      // Each run is a paid multi-prompt Anthropic call; cap per shop to bound
      // LLM spend abuse (same posture as the assistant endpoint).
      if (!(await rateLimit(`storegen:${session.shopId}`, 5, 60_000))) {
        return jsonError(429, "rate_limited", "Too many generations. Please wait a moment.");
      }
      if (b.brief !== undefined && typeof b.brief !== "string") {
        return jsonError(422, "invalid_brief");
      }
      if (typeof b.brief === "string" && b.brief.length > BRIEF_MAX) {
        return jsonError(422, "brief_too_long", "Keep the brief under 4,000 characters.");
      }
      const brief = typeof b.brief === "string" && b.brief.trim() ? b.brief.trim() : undefined;
      // Daily cap + cooldown on top of the burst limit — after validation so
      // rejected requests never burn the day's allowance (see ai-quota.server).
      const quota = await checkAiQuota({
        shopId: session.shopId,
        feature: "designer",
        trusted: quotaTrusted(session),
      });
      if (!quota.allowed) return jsonError(429, quota.code, quota.message);
      try {
        // Real generation — can take several seconds; awaited deliberately.
        const result = await generateStore({
          shopId: session.shopId,
          mode: brief ? "brief" : "catalog",
          brief,
        });
        return jsonOk({ runId: result.runId, status: result.status });
      } catch (err) {
        console.error("[dashboard.api.store] store generation failed", err);
        return jsonError(502, "generation_failed", "Store generation failed — please try again.");
      }
    }

    case "publish": {
      return dashboardJson(async () => {
        await publishStudioStore(session.shopId);
        return { publishedAt: new Date().toISOString() };
      });
    }

    default:
      return jsonError(422, "unknown_action");
  }
}
