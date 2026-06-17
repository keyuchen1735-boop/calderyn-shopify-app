// app/lib/social-digest/run.server.ts
//
// Orchestrator for the weekly social digest (entry point for cron.social-digest).
// Collects the trailing 7 days of GitHub activity + new waitlist signups, turns
// them into LinkedIn + Instagram carousel copy (AI with deterministic fallback),
// renders the slides to PNGs, and emails them — inline + attached — to the
// founders via Resend. Returns a structured summary that records every failure
// mode instead of throwing or faking success (rule 12).

import { collectActivity } from "../github-digest/collect.server";
import { collectWaitlistSignups } from "../github-digest/waitlist.server";
import { sendEmail, type DeliveryResult, type EmailAttachment } from "../email/send.server";
import { buildSocialPack } from "./pack.server";
import { buildCarousels } from "./slides.server";
import { renderSlideSets } from "./render.server";

const DEFAULT_REPO = "keyuchen1735-boop/calderyn-shopify-app";
const DEFAULT_TO = ["keyuchen@calderyncompany.com", "john@calderyncompany.com", "kennethlee@calderyncompany.com"];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * ONE_DAY_MS;

export interface SocialRunSummary {
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

function emailHtml(opts: {
  range: string;
  shippedCount: number;
  waitlistDelta: number;
  liCids: string[];
  igCids: string[];
  liCaption: string;
  igCaption: string;
}): string {
  const row = (cids: string[]) =>
    `<div style="margin:10px 0 4px">${cids
      .map((c) => `<img src="cid:${c}" width="150" style="border-radius:8px;border:1px solid #d9d6cc;margin-right:8px"/>`)
      .join("")}</div>`;
  const pre = (s: string) =>
    `<pre style="white-space:pre-wrap;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#f6f5f0;border:1px solid #e4e1d7;border-radius:10px;padding:16px;color:#17363a">${escapeHtml(
      s,
    )}</pre>`;
  return `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#17363a;max-width:680px">
  <h2 style="margin:0 0 4px">Calderyn — weekly social drop</h2>
  <div style="color:#5b6b6e;margin-bottom:18px">Week of ${escapeHtml(opts.range)} · ${opts.shippedCount} shipped · +${opts.waitlistDelta} waitlist</div>
  <p>Ready-to-post carousels — 4:5 portrait, rendered at 2160×2700 (downsize to 1080×1350 if your tool needs it). Slides are attached individually; captions are copy-paste ready.</p>
  <h3 style="margin:22px 0 2px;color:#1e7079">LinkedIn carousel (4 slides)</h3>
  ${row(opts.liCids)}
  ${pre(opts.liCaption)}
  <h3 style="margin:22px 0 2px;color:#1e7079">Instagram carousel (4 slides) — different creative</h3>
  ${row(opts.igCids)}
  ${pre(opts.igCaption)}
  <p style="color:#8a8a8a;font-size:13px;margin-top:22px">Numbers labelled “Illustrative · demo store” are placeholders until real aggregates are publishable. Auto-sent by the weekly social-digest cron.</p>
</div>`;
}

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

  const liCids = liShots.map((_, i) => `li${i + 1}`);
  const igCids = igShots.map((_, i) => `ig${i + 1}`);
  const attachments: EmailAttachment[] = [
    ...liShots.map((b, i) => ({
      filename: `linkedin-slide-${i + 1}.png`,
      content: b.toString("base64"),
      contentType: "image/png",
      contentId: liCids[i],
    })),
    ...igShots.map((b, i) => ({
      filename: `instagram-slide-${i + 1}.png`,
      content: b.toString("base64"),
      contentType: "image/png",
      contentId: igCids[i],
    })),
  ];

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  let delivery: DeliveryResult;
  if (!apiKey || !from) {
    const missing = [!apiKey && "RESEND_API_KEY", !from && "DIGEST_FROM"].filter(Boolean).join(", ");
    delivery = { sent: false, error: `email not configured (${missing})` };
  } else {
    delivery = await sendEmail({
      apiKey,
      from,
      to,
      subject: `Calderyn social — week of ${range} (LinkedIn + Instagram)`,
      text: `Calderyn weekly social drop — week of ${range}. ${shippedCount} shipped, +${waitlistDelta} waitlist. LinkedIn + Instagram carousels (4 slides each) attached; captions in the HTML body.`,
      html: emailHtml({ range, shippedCount, waitlistDelta, liCids, igCids, liCaption: pack.linkedinCaption, igCaption: pack.instagramCaption }),
      attachments,
    });
  }

  return {
    ...base,
    shippedCount,
    waitlistDelta,
    copyMode: mode,
    slides: { linkedin: liShots.length, instagram: igShots.length },
    delivery,
    error: null,
  };
}
