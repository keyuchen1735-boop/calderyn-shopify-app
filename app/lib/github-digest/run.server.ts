// app/lib/github-digest/run.server.ts
//
// Orchestrator for the daily GitHub progress digest (entry point for
// cron.github-digest.tsx). Wiring only: read config from env, collect activity,
// summarize, deliver — and return a structured summary that records EVERY
// failure mode (missing secrets, collection error, AI degradation, delivery
// failure) instead of throwing or faking success (rule 12).
//
// Required env for live delivery (the route returns 500 until these are set):
//   GITHUB_TOKEN     read access to the repo (contents + pull requests)
//   RESEND_API_KEY   Resend API key
//   DIGEST_FROM      verified Resend sender, e.g. "Calderyn <digest@example.com>"
// Optional env:
//   DIGEST_REPO      default "keyuchen1735-boop/calderyn-shopify-app". When set to
//                    a non-default repo, the Calderyn waitlist section is skipped
//                    (that data belongs to the default repo/brand only).
//   DIGEST_BRAND     default "Calderyn" — subject line + email header wordmark.
//   DIGEST_TO        default "kennethlee@calderyncompany.com"
//   ANTHROPIC_API_KEY  (already used by the in-app assistant) enables AI prose

import { collectActivity } from "./collect.server";
import { collectWaitlistSignups, type WaitlistResult } from "./waitlist.server";
import { summarize } from "./summarize.server";
import { sendEmail, type DeliveryResult } from "~/lib/email/send.server";

const DEFAULT_REPO = "keyuchen1735-boop/calderyn-shopify-app";
const DEFAULT_TO = "kennethlee@calderyncompany.com";
const DEFAULT_BRAND = "Calderyn";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DigestRunSummary {
  repo: string;
  sinceIso: string;
  commitCount: number;
  mergedPRCount: number;
  openedPRCount: number;
  branchesScanned: number;
  branchesTotal: number;
  waitlistSignupCount: number;
  summaryMode: "ai" | "template" | "empty" | "none";
  delivery: DeliveryResult;
  to: string;
  cc: string[];
  notes: string[];
  error: string | null;
}

function dateLabelET(nowMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(nowMs));
}

function empty(repo: string, sinceIso: string, error: string): DigestRunSummary {
  return {
    repo,
    sinceIso,
    commitCount: 0,
    mergedPRCount: 0,
    openedPRCount: 0,
    branchesScanned: 0,
    branchesTotal: 0,
    waitlistSignupCount: 0,
    summaryMode: "none",
    delivery: { sent: false, error: "not attempted" },
    to: "",
    cc: [],
    notes: [],
    error,
  };
}

export async function runGithubDigest(opts?: { nowMs?: number }): Promise<DigestRunSummary> {
  const nowMs = opts?.nowMs ?? Date.now();
  const sinceMs = nowMs - WINDOW_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const repo = process.env.DIGEST_REPO || DEFAULT_REPO;
  const brand = process.env.DIGEST_BRAND || DEFAULT_BRAND;
  const isDefaultRepo = repo === DEFAULT_REPO;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return empty(repo, sinceIso, "GITHUB_TOKEN is not set");
  }

  let activity;
  try {
    activity = await collectActivity({ repo, token, sinceMs });
  } catch (err) {
    return empty(repo, sinceIso, `collect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const notes = [...activity.notes];

  // New waitlist signups in the same trailing window. Independent of GitHub:
  // a failure here is surfaced as a note, not a thrown digest (rule 12). The
  // waitlist table is Calderyn-specific, so it's only collected when this
  // digest is reporting on the default (Calderyn) repo.
  let waitlist: WaitlistResult;
  if (isDefaultRepo) {
    waitlist = await collectWaitlistSignups({ sinceMs });
    if (waitlist.note) notes.push(waitlist.note);
  } else {
    waitlist = { signups: [], note: null };
    notes.push(`Waitlist signups skipped — digest repo (${repo}) is not the default Calderyn repo.`);
  }

  const dateLabel = dateLabelET(nowMs);
  const content = await summarize(activity, { dateLabel, signups: waitlist.signups, brand, repo });
  if (process.env.ANTHROPIC_API_KEY && content.mode === "template") {
    notes.push("AI summary unavailable — fell back to grouped template.");
  }

  // Deliver. Missing email config is a visible delivery failure, not a silent skip.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  const to = process.env.DIGEST_TO || DEFAULT_TO;
  const cc = (process.env.DIGEST_CC || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let delivery: DeliveryResult;
  if (!apiKey || !from) {
    const missing = [!apiKey && "RESEND_API_KEY", !from && "DIGEST_FROM"].filter(Boolean).join(", ");
    delivery = { sent: false, error: `email not configured (${missing})` };
  } else {
    delivery = await sendEmail({
      apiKey,
      from,
      to,
      cc,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
  }

  return {
    repo,
    sinceIso,
    commitCount: activity.commits.length,
    mergedPRCount: activity.mergedPRs.length,
    openedPRCount: activity.openedPRs.length,
    branchesScanned: activity.branchesScanned,
    branchesTotal: activity.branchesTotal,
    waitlistSignupCount: waitlist.signups.length,
    summaryMode: content.mode,
    delivery,
    to,
    cc,
    notes,
    error: null,
  };
}
