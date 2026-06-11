// app/lib/github-digest/summarize.server.ts
//
// Turns collected GitHub Activity into a plain-English digest body a
// non-engineer can read. Two modes:
//   - "ai":       prose written by the in-app Anthropic client (preferred).
//   - "template": a deterministic, grouped fallback used when ANTHROPIC_API_KEY
//                 is unset OR the model call fails. Guarantees we always have a
//                 readable body to send — the digest never silently degrades to
//                 nothing (rule 12).
//   - "empty":    the one-liner for a day with zero activity.
//
// `buildTemplateSummary` is a pure function (no env, no network) so it is unit
// tested directly for grouping/labelling behavior.

import type { Activity, CommitInfo, PullInfo } from "./collect.server";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";

export interface DigestContent {
  subject: string;
  text: string;
  mode: "ai" | "template" | "empty";
}

function isEmpty(a: Activity): boolean {
  return a.commits.length === 0 && a.mergedPRs.length === 0 && a.openedPRs.length === 0;
}

// Conventional-commit prefix -> human-friendly bucket. Order here is the order
// buckets appear in the rendered summary.
const BUCKETS: { label: string; types: string[] }[] = [
  { label: "New features", types: ["feat"] },
  { label: "Bug fixes", types: ["fix"] },
  { label: "Performance", types: ["perf"] },
  { label: "Code cleanup", types: ["refactor", "style"] },
  { label: "Documentation", types: ["docs"] },
  { label: "Tests", types: ["test"] },
  { label: "Maintenance", types: ["chore", "build", "ci"] },
];
const OTHER_LABEL = "Other changes";

/** Split "feat(scope): do thing" -> { type: "feat", text: "do thing" }. */
function splitConventional(subject: string): { type: string | null; text: string } {
  const m = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject);
  if (!m) return { type: null, text: subject };
  return { type: m[1].toLowerCase(), text: m[2] };
}

function bucketFor(type: string | null): string {
  if (!type) return OTHER_LABEL;
  for (const b of BUCKETS) {
    if (b.types.includes(type)) return b.label;
  }
  return OTHER_LABEL;
}

function renderPullLine(p: PullInfo): string {
  return `  - #${p.number} ${p.title} (@${p.author})`;
}

/**
 * Deterministic grouped summary. Pure — given the same Activity + label it
 * always produces the same text. This is the tested unit and the safety net.
 */
export function buildTemplateSummary(activity: Activity, dateLabel: string): string {
  const lines: string[] = [`Calderyn — development progress for ${dateLabel}`, ""];

  // Group commits into friendly buckets, preserving bucket order.
  const grouped = new Map<string, string[]>();
  for (const c of activity.commits) {
    const { type, text } = splitConventional(c.subject);
    const label = bucketFor(type);
    const arr = grouped.get(label) ?? [];
    arr.push(`  - ${text}`);
    grouped.set(label, arr);
  }

  const orderedLabels = [...BUCKETS.map((b) => b.label), OTHER_LABEL];
  const commitCount = activity.commits.length;
  if (commitCount > 0) {
    lines.push(`Commits (${commitCount}):`);
    for (const label of orderedLabels) {
      const items = grouped.get(label);
      if (items && items.length) {
        lines.push(`${label}:`, ...items, "");
      }
    }
  }

  if (activity.mergedPRs.length) {
    lines.push(`Pull requests merged (${activity.mergedPRs.length}):`);
    lines.push(...activity.mergedPRs.map(renderPullLine), "");
  }
  if (activity.openedPRs.length) {
    lines.push(`Pull requests opened (${activity.openedPRs.length}):`);
    lines.push(...activity.openedPRs.map(renderPullLine), "");
  }

  for (const note of activity.notes) {
    lines.push(`Note: ${note}`);
  }

  return lines.join("\n").trimEnd();
}

/** Compact, deterministic activity dump fed to the model as context. */
function activityForPrompt(activity: Activity): string {
  const shown = activity.commits.slice(0, 80);
  const commitLines = shown.map((c: CommitInfo) => `- [${c.branch}] ${c.subject} (${c.author})`);
  const merged = activity.mergedPRs.map((p) => `- MERGED #${p.number} ${p.title} — ${p.body}`);
  const opened = activity.openedPRs.map((p) => `- OPENED #${p.number} ${p.title} — ${p.body}`);
  const commitHeader =
    activity.commits.length > shown.length
      ? `Commits (${activity.commits.length}, showing first ${shown.length}):`
      : `Commits (${activity.commits.length}):`;
  return [
    `Repository: ${activity.repo}`,
    `Window since: ${activity.sinceIso}`,
    "",
    commitHeader,
    ...(commitLines.length ? commitLines : ["(none)"]),
    "",
    `Pull requests merged (${activity.mergedPRs.length}):`,
    ...(merged.length ? merged : ["(none)"]),
    "",
    `Pull requests opened (${activity.openedPRs.length}):`,
    ...(opened.length ? opened : ["(none)"]),
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You write a short daily engineering progress update for a non-technical reader (a founder).",
  "Input is raw git commit subjects and pull-request titles from the last 24 hours.",
  "Write plain English. Group related work into themes. Lead with what shipped (completed/merged),",
  "then what is in progress, then anything notable (releases, reverts, security- or money-related changes).",
  "Do NOT include commit hashes, branch names, or git jargon. No preamble or sign-off — just the update.",
  "Keep it tight: a few short paragraphs or grouped bullets.",
].join(" ");

async function aiSummary(activity: Activity): Promise<string> {
  const client = getAnthropic();
  const msg = await client.messages.create({
    model: assistantModel(),
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: activityForPrompt(activity) }],
  });
  const text = msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned an empty summary");
  return text;
}

/**
 * Produce the digest content. Prefers AI prose; falls back to the deterministic
 * template on missing key or any model error (the failure is appended to
 * activity.notes by the caller via the returned mode).
 */
export async function summarize(
  activity: Activity,
  opts: { dateLabel: string },
): Promise<DigestContent> {
  const subject = `Calderyn dev digest — ${opts.dateLabel}`;

  if (isEmpty(activity)) {
    return { subject, text: "No commits or PRs in the last 24h.", mode: "empty" };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const text = await aiSummary(activity);
      return { subject, text, mode: "ai" };
    } catch {
      // fall through to template; caller records the degradation
    }
  }

  return { subject, text: buildTemplateSummary(activity, opts.dateLabel), mode: "template" };
}
