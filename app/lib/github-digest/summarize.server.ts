// app/lib/github-digest/summarize.server.ts
//
// Turns collected Activity into the digest email: a branded HTML body plus a
// plaintext twin, attributed per person. The model writes a short plain-English
// overview and a one-line "what they did" per person (structured JSON); if the
// key is missing or the call/parse fails, a deterministic fallback fills the
// overview and the per-person meta still attributes the work — the digest never
// degrades to nothing (rule 12). Rendering itself lives in render.server.ts.

import type { Activity } from "./collect.server";
import {
  groupByActor,
  renderHtml,
  renderText,
  renderEmptyHtml,
  type PersonGroup,
  type RenderInput,
} from "./render.server";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";

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

const SYSTEM_PROMPT = [
  "You write a daily git-activity digest for a non-technical founder.",
  "You are given the day's work grouped by person.",
  'Respond with ONLY a JSON object (no markdown, no code fences) of the exact shape:',
  '{"overview": string, "people": { "<key>": string }}',
  '- "overview": 2-3 plain-English sentences about the day overall. No commit hashes, no branch names, no git jargon.',
  '- "people": one entry per provided person key; the value is ONE plain-English sentence about what that person worked on.',
  "Use only the person keys provided. Output JSON only.",
].join(" ");

function activityForPrompt(groups: PersonGroup[], dateLabel: string): string {
  const blocks = groups.map((g) => {
    const commitLines = g.commits.slice(0, 40).map((c) => `    - ${c.subject}`);
    const prLines = g.mergedPRs.slice(0, 20).map((p) => `    - merged #${p.number} ${p.title}`);
    const openLines = g.openedPRs.slice(0, 10).map((p) => `    - opened #${p.number} ${p.title}`);
    return [
      `Person key "${g.actor.key}" (${g.actor.label}): ${g.commits.length} commits, ${g.mergedPRs.length} merged, ${g.openedPRs.length} opened`,
      ...(commitLines.length ? ["  commits:", ...commitLines] : []),
      ...(prLines.length || openLines.length ? ["  pull requests:", ...prLines, ...openLines] : []),
    ].join("\n");
  });
  return [`Date: ${dateLabel}`, "", ...blocks].join("\n");
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

async function aiStructured(groups: PersonGroup[], dateLabel: string): Promise<AiResult | null> {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: assistantModel(),
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: activityForPrompt(groups, dateLabel) }],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  return parseAi(text);
}

function fallbackOverview(activity: Activity): string {
  const c = activity.commits.length;
  const m = activity.mergedPRs.length;
  return `${c} commit${c === 1 ? "" : "s"} and ${m} pull request${m === 1 ? "" : "s"} merged across the team in the last 24 hours.`;
}

export async function summarize(activity: Activity, opts: { dateLabel: string }): Promise<DigestContent> {
  const subject = `Calderyn dev digest — ${opts.dateLabel}`;

  if (isEmpty(activity)) {
    return {
      subject,
      text: "No commits or PRs in the last 24h.",
      html: renderEmptyHtml(opts.dateLabel),
      mode: "empty",
    };
  }

  const groups = groupByActor(activity);
  let input: RenderInput = { dateLabel: opts.dateLabel, overview: fallbackOverview(activity), prose: {} };
  let mode: DigestContent["mode"] = "template";

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const ai = await aiStructured(groups, opts.dateLabel);
      if (ai) {
        input = { dateLabel: opts.dateLabel, overview: ai.overview, prose: ai.people };
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
