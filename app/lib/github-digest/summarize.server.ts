// app/lib/github-digest/summarize.server.ts
//
// Turns collected Activity into the digest email: a branded HTML body plus a
// plaintext twin, attributed per person. The model writes a short plain-English
// overview and a one-line "what they did" per person (structured JSON); if the
// key is missing or the call/parse fails, a deterministic fallback fills the
// overview and the per-person meta still attributes the work — the digest never
// degrades to nothing (rule 12). Rendering itself lives in render.server.ts.

import { repoLabel, type Activity } from "./collect.server";
import {
  groupByActor,
  renderHtml,
  renderText,
  renderEmptyHtml,
  type PersonGroup,
  type RenderInput,
} from "./render.server";
import { getAnthropic, digestModel } from "~/lib/assistant/anthropic.server";
import type { WaitlistSignup } from "./waitlist.server";

export interface DigestContent {
  subject: string;
  text: string;
  html: string;
  mode: "ai" | "template" | "empty";
}

interface AiResult {
  overview: string;
  people: Record<string, string>;
}

function isEmpty(a: Activity): boolean {
  return a.commits.length === 0 && a.mergedPRs.length === 0 && a.openedPRs.length === 0;
}

function systemPrompt(brand: string, repos: string[]): string {
  return [
    `You write a daily git-activity digest for the non-technical founder of ${brand}.`,
    "You are given the day's work grouped by person.",
    ...(repos.length > 1
      ? [
          `The work spans ${repos.length} repositories (${repos.map(repoLabel).join(", ")}); each line is tagged with its repo in square brackets.`,
          "Say which part of the product each person worked on when it is not obvious, but never print the bracketed tags or repo names verbatim.",
        ]
      : []),
    'Respond with ONLY a JSON object (no markdown, no code fences) of the exact shape:',
    '{"overview": string, "people": { "<key>": string }}',
    '- "overview": 2-3 plain-English sentences about the day overall. No commit hashes, no branch names, no git jargon.',
    '- "people": one entry per provided person key; the value is ONE plain-English sentence about what that person worked on.',
    "Use only the person keys provided. Output JSON only.",
  ].join(" ");
}

function activityForPrompt(groups: PersonGroup[], dateLabel: string, repos: string[]): string {
  // Each line is tagged with its repo when several are tracked, so the model can
  // say which product a person worked on rather than blurring them together.
  const multiRepo = repos.length > 1;
  const tag = (repo: string) => (multiRepo && repo ? `[${repoLabel(repo)}] ` : "");
  const blocks = groups.map((g) => {
    const commitLines = g.commits.slice(0, 40).map((c) => `    - ${tag(c.repo)}${c.subject}`);
    const prLines = g.mergedPRs.slice(0, 20).map((p) => `    - ${tag(p.repo)}merged #${p.number} ${p.title}`);
    const openLines = g.openedPRs.slice(0, 10).map((p) => `    - ${tag(p.repo)}opened #${p.number} ${p.title}`);
    return [
      `Person key "${g.actor.key}" (${g.actor.label}): ${g.commits.length} commits, ${g.mergedPRs.length} merged, ${g.openedPRs.length} opened`,
      ...(commitLines.length ? ["  commits:", ...commitLines] : []),
      ...(prLines.length || openLines.length ? ["  pull requests:", ...prLines, ...openLines] : []),
    ].join("\n");
  });
  const header = multiRepo
    ? [`Date: ${dateLabel}`, `Repositories covered: ${repos.map(repoLabel).join(", ")}`]
    : [`Date: ${dateLabel}`];
  return [...header, "", ...blocks].join("\n");
}

function parseAi(raw: string): AiResult | null {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.overview !== "string") return null;
  const people: Record<string, string> = {};
  if (typeof obj.people === "object" && obj.people !== null) {
    for (const [k, v] of Object.entries(obj.people as Record<string, unknown>)) {
      if (typeof v === "string") people[k] = v;
    }
  }
  return { overview: obj.overview, people };
}

async function aiStructured(
  groups: PersonGroup[],
  dateLabel: string,
  brand: string,
  repos: string[],
): Promise<AiResult | null> {
  const client = getAnthropic();
  // No cache_control: the system prompt is ~150 tokens, below this model's
  // 2048-token minimum cacheable prefix, and this runs once per day (cron),
  // so the prefix is never re-read within the 5-minute cache TTL. Caching
  // would be a no-op at best and a 1.25x write premium for zero reads at
  // worst, so it is intentionally omitted.
  const msg = await client.messages.create({
    model: digestModel(),
    max_tokens: 1024,
    system: systemPrompt(brand, repos),
    messages: [{ role: "user", content: activityForPrompt(groups, dateLabel, repos) }],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  return parseAi(text);
}

function fallbackOverview(activity: Activity): string {
  const c = activity.commits.length;
  const m = activity.mergedPRs.length;
  return `${c} commit${c === 1 ? "" : "s"} and ${m} pull request${m === 1 ? "" : "s"} merged across the team in the last 24 hours.`;
}

export async function summarize(
  activity: Activity,
  opts: { dateLabel: string; signups?: WaitlistSignup[]; brand?: string },
): Promise<DigestContent> {
  const brand = opts.brand || "Calderyn";
  const subject = `${brand} dev digest — ${opts.dateLabel}`;
  const signups = opts.signups ?? [];
  const gitEmpty = isEmpty(activity);

  // Quiet day only when there is NOTHING to report — no code AND no signups.
  if (gitEmpty && signups.length === 0) {
    return {
      subject,
      text: "No commits, PRs, or new waitlist signups in the last 24h.",
      html: renderEmptyHtml(opts.dateLabel, brand),
      mode: "empty",
    };
  }

  const groups = groupByActor(activity);
  // The AI prompt summarizes git work only; signups (which carry PII) are
  // rendered deterministically and never sent to the model.
  let input: RenderInput = {
    dateLabel: opts.dateLabel,
    brand,
    overview: gitEmpty ? "" : fallbackOverview(activity),
    prose: {},
    signups,
  };
  let mode: DigestContent["mode"] = "template";

  const repos = activity.repos?.length ? activity.repos : [activity.repo].filter(Boolean);
  if (!gitEmpty && process.env.ANTHROPIC_API_KEY) {
    try {
      const ai = await aiStructured(groups, opts.dateLabel, brand, repos);
      if (ai) {
        input = { dateLabel: opts.dateLabel, brand, overview: ai.overview, prose: ai.people, signups };
        mode = "ai";
      }
    } catch {
      // keep deterministic fallback
    }
  }

  return {
    subject,
    text: renderText(activity, groups, input),
    html: renderHtml(activity, groups, input),
    mode,
  };
}
