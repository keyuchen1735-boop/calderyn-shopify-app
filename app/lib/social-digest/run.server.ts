// app/lib/social-digest/run.server.ts
//
// Orchestrator for the weekly social digest (entry point for cron.social-digest).
// Collects the trailing 7 days of GitHub activity + new waitlist signups, turns
// them into LinkedIn + Instagram carousel copy (AI with deterministic fallback),
// renders the slides to PNGs, persists the row to Supabase, and emails a DECISION
// email with inline previews and signed Approve / Reject links. Returns a
// structured summary that records every failure mode instead of throwing or faking
// success (rule 12).

import { randomUUID } from "node:crypto";
import { collectActivity } from "../github-digest/collect.server";
import { collectWaitlistSignups } from "../github-digest/waitlist.server";
import { sendEmail, type DeliveryResult } from "../email/send.server";
import { buildSocialPack } from "./pack.server";
import { buildCarousels } from "./slides.server";
import { renderSlideSets } from "./render.server";
import { storeSlides, signedUrls } from "./store.server";
import { signActionToken } from "./token.server";
import { getSupabase } from "../supabase.server";

const DEFAULT_REPO = "keyuchen1735-boop/calderyn-shopify-app";
const DEFAULT_TO = ["keyuchen@calderyncompany.com", "john@calderyncompany.com", "kennethlee@calderyncompany.com"];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * ONE_DAY_MS;

export interface SocialRunSummary {
  digestId: string | null;
  status: "pending" | "error";
  range: string;
  sinceIso: string;
  shippedCount: number;
  waitlistDelta: number;
  copyMode: "ai" | "template" | "none";
  slides: { linkedin: number; instagram: number };
  delivery: DeliveryResult;
  to: string[];
  notes: string[];
  error: string | null;
}

function rangeLabel(startMs: number, endMs: number): string {
  const TZ = "America/New_York";
  const part = (ms: number, opt: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opt }).format(new Date(ms));
  const sMonth = part(startMs, { month: "long" });
  const eMonth = part(endMs, { month: "long" });
  const sDay = part(startMs, { day: "numeric" });
  const eDay = part(endMs, { day: "numeric" });
  const year = part(endMs, { year: "numeric" });
  return sMonth === eMonth
    ? `${sMonth} ${sDay}–${eDay}, ${year}`
    : `${sMonth} ${sDay} – ${eMonth} ${eDay}, ${year}`;
}

function recipients(): string[] {
  const raw = (process.env.SOCIAL_DIGEST_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TO;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Pure, testable email builder — no I/O.
// ---------------------------------------------------------------------------

export interface ActionEmailOpts {
  range: string;
  shippedCount: number;
  waitlistDelta: number;
  liUrls: string[];
  igUrls: string[];
  approveUrl: string;
  rejectUrl: string;
}

export function buildActionEmail(opts: ActionEmailOpts): { subject: string; text: string; html: string } {
  const { range, shippedCount, waitlistDelta, liUrls, igUrls, approveUrl, rejectUrl } = opts;

  const subject = `Calderyn social — approve or reject: week of ${range}`;

  const imgRow = (urls: string[]) =>
    `<div style="margin:10px 0 4px">${urls
      .map(
        (u) =>
          `<img src="${escapeHtml(u)}" width="150" style="border-radius:8px;border:1px solid #d9d6cc;margin-right:8px"/>`,
      )
      .join("")}</div>`;

  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#17363a;max-width:680px">
  <h2 style="margin:0 0 4px">Calderyn — weekly social drop</h2>
  <div style="color:#5b6b6e;margin-bottom:18px">Week of ${escapeHtml(range)} · ${shippedCount} shipped · +${waitlistDelta} waitlist</div>
  <h3 style="margin:22px 0 2px;color:#1e7079">LinkedIn previews</h3>
  ${imgRow(liUrls)}
  <h3 style="margin:22px 0 2px;color:#1e7079">Instagram previews</h3>
  ${imgRow(igUrls)}
  <div style="margin-top:32px;display:flex;gap:16px">
    <a href="${escapeHtml(approveUrl)}" style="display:inline-block;padding:14px 28px;background:#1a8a5a;color:#fff;font-weight:700;font-size:15px;border-radius:8px;text-decoration:none">Approve &amp; post</a>
    <a href="${escapeHtml(rejectUrl)}" style="display:inline-block;padding:14px 28px;background:#8a8a8a;color:#fff;font-weight:700;font-size:15px;border-radius:8px;text-decoration:none">Reject &amp; regenerate</a>
  </div>
  <p style="color:#8a8a8a;font-size:13px;margin-top:22px">Auto-sent by the weekly social-digest cron. Links expire in 7 days.</p>
</div>`;

  const text = [
    `Calderyn — weekly social drop`,
    `Week of ${range} · ${shippedCount} shipped · +${waitlistDelta} waitlist`,
    ``,
    `APPROVE & POST:`,
    approveUrl,
    ``,
    `REJECT & REGENERATE:`,
    rejectUrl,
  ].join("\n");

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runSocialDigest(opts?: { nowMs?: number }): Promise<SocialRunSummary> {
  const nowMs = opts?.nowMs ?? Date.now();
  const sinceMs = nowMs - WINDOW_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  // Data window is a full 7×24h; the human label reads as the 7 inclusive dates
  // ending today (e.g. "June 13–19") rather than the 8-date Fri–Fri span.
  const range = rangeLabel(nowMs - 6 * ONE_DAY_MS, nowMs);
  const to = recipients();
  const notes: string[] = [];

  const base: Omit<SocialRunSummary, "delivery" | "error"> = {
    digestId: null,
    status: "error",
    range,
    sinceIso,
    shippedCount: 0,
    waitlistDelta: 0,
    copyMode: "none",
    slides: { linkedin: 0, instagram: 0 },
    to,
    notes,
  };

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ...base, delivery: { sent: false, error: "not attempted" }, error: "GITHUB_TOKEN is not set" };
  }
  const repo = process.env.DIGEST_REPO || DEFAULT_REPO;

  let activity;
  try {
    activity = await collectActivity({ repo, token, sinceMs });
  } catch (err) {
    return {
      ...base,
      delivery: { sent: false, error: "not attempted" },
      error: `collect failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  notes.push(...activity.notes);

  const waitlist = await collectWaitlistSignups({ sinceMs });
  if (waitlist.note) notes.push(waitlist.note);
  const waitlistDelta = waitlist.signups.length;
  const shippedCount = activity.mergedPRs.length;

  const { pack, mode } = await buildSocialPack({ activity, range, shippedCount, waitlistDelta });

  let liShots: Buffer[];
  let igShots: Buffer[];
  try {
    const { linkedinHtml, instagramHtml } = buildCarousels(pack);
    const [li, ig] = await renderSlideSets([linkedinHtml, instagramHtml]);
    liShots = li;
    igShots = ig;
  } catch (err) {
    return {
      ...base,
      shippedCount,
      waitlistDelta,
      copyMode: mode,
      delivery: { sent: false, error: "not attempted" },
      error: `render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Persist slides to storage.
  const id = randomUUID();
  let liPaths: string[];
  let igPaths: string[];
  try {
    ({ liPaths, igPaths } = await storeSlides(id, liShots, igShots));
  } catch (err) {
    return {
      ...base,
      shippedCount,
      waitlistDelta,
      copyMode: mode,
      slides: { linkedin: liShots.length, instagram: igShots.length },
      delivery: { sent: false, error: "not attempted" },
      error: `storeSlides failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Insert the DB row.
  const row = {
    id,
    week_range: range,
    since_iso: sinceIso,
    status: "pending" as const,
    regen_count: 0,
    pack_json: pack,
    li_image_paths: liPaths,
    ig_image_paths: igPaths,
    li_caption: pack.linkedinCaption,
    ig_caption: pack.instagramCaption,
    prior_copy_json: [],
  };
  const { error: insertError } = await getSupabase().from("social_digest").insert(row);
  if (insertError) {
    return {
      ...base,
      shippedCount,
      waitlistDelta,
      copyMode: mode,
      slides: { linkedin: liShots.length, instagram: igShots.length },
      delivery: { sent: false, error: "not attempted" },
      error: `DB insert failed: ${insertError.message}`,
    };
  }

  // Mint signed preview URLs and action tokens.
  let liUrls: string[];
  let igUrls: string[];
  try {
    [liUrls, igUrls] = await Promise.all([signedUrls(liPaths), signedUrls(igPaths)]);
  } catch (err) {
    return {
      ...base,
      digestId: id,
      status: "pending",
      shippedCount,
      waitlistDelta,
      copyMode: mode,
      slides: { linkedin: liShots.length, instagram: igShots.length },
      delivery: { sent: false, error: "not attempted" },
      error: `signedUrls failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const approveToken = signActionToken(id, "approve", 0);
  const rejectToken = signActionToken(id, "reject", 0);
  const baseUrl = process.env.SOCIAL_DIGEST_BASE_URL ?? "https://app.calderyncompany.com";
  const approveUrl = `${baseUrl}/social/review/${id}?t=${approveToken}`;
  const rejectUrl = `${baseUrl}/social/review/${id}?t=${rejectToken}`;

  // Send the decision email.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  let delivery: DeliveryResult;
  if (!apiKey || !from) {
    const missing = [!apiKey && "RESEND_API_KEY", !from && "DIGEST_FROM"].filter(Boolean).join(", ");
    delivery = { sent: false, error: `email not configured (${missing})` };
  } else {
    const { subject, text, html } = buildActionEmail({
      range,
      shippedCount,
      waitlistDelta,
      liUrls,
      igUrls,
      approveUrl,
      rejectUrl,
    });
    delivery = await sendEmail({ apiKey, from, to, subject, text, html });
  }

  return {
    digestId: id,
    status: "pending",
    range,
    sinceIso,
    shippedCount,
    waitlistDelta,
    copyMode: mode,
    slides: { linkedin: liShots.length, instagram: igShots.length },
    delivery,
    to,
    notes,
    error: null,
  };
}
