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
import { buildCarousels, type SocialPack } from "./slides.server";
import { renderSlideSets } from "./render.server";
import { storeSlides, signedUrls } from "./store.server";
import { signActionToken } from "./token.server";
import { getSupabase } from "../supabase.server";

const DEFAULT_REPO = "keyuchen1735-boop/calderyn-shopify-app";
const DEFAULT_TO = ["keyuchen@calderyncompany.com", "john@calderyncompany.com", "kennethlee@calderyncompany.com"];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 7 * ONE_DAY_MS;
const MAX_REGENS = 5;

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

export function recipients(): string[] {
  const raw = (process.env.SOCIAL_DIGEST_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : DEFAULT_TO;
}

// ---------------------------------------------------------------------------
// extractPriorCopy — pure helper to collect all human-readable copy strings
// from a SocialPack so regeneration can tell the model what to avoid.
// ---------------------------------------------------------------------------

export function extractPriorCopy(pack: SocialPack): string[] {
  const candidates: string[] = [
    pack.linkedin.coverA,
    pack.linkedin.coverB,
    pack.linkedin.features[0].title,
    pack.linkedin.features[1].title,
    pack.linkedin.ctaHeadline,
    pack.instagram.coverA,
    pack.instagram.coverHi,
    pack.instagram.coverB,
    pack.instagram.bigLabel,
    pack.instagram.feature.title,
    pack.linkedinCaption,
    pack.instagramCaption,
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of candidates) {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
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
  liCaption: string;
  igCaption: string;
  /**
   * One combined "Approve & post" link per founder.
   * Clicking the link posts LinkedIn to that founder's profile AND surfaces
   * the Instagram slides for manual posting.
   */
  approvals: { label: string; url: string }[];
  rejectUrl: string;
}

// Best-effort: mark a drop failed so a half-built row (inserted, but no email
// sent) isn't mistaken for one awaiting a decision. Never throws — it must not
// mask the original error the caller is already reporting.
async function markDigestFailed(id: string): Promise<void> {
  try {
    await getSupabase().from("social_digest").update({ status: "failed" }).eq("id", id);
  } catch {
    // swallow — caller already returns an error summary
  }
}

export function buildActionEmail(opts: ActionEmailOpts): { subject: string; text: string; html: string } {
  const {
    range, shippedCount, waitlistDelta, liUrls, igUrls, liCaption, igCaption,
    approvals, rejectUrl,
  } = opts;

  const subject = `Calderyn social — approve or reject: week of ${range}`;

  const imgRow = (urls: string[]) =>
    `<div style="margin:10px 0 4px">${urls
      .map(
        (u) =>
          `<img src="${escapeHtml(u)}" width="150" style="border-radius:8px;border:1px solid #d9d6cc;margin-right:8px"/>`,
      )
      .join("")}</div>`;

  // Caption block — the post description, shown copy-ready in a monospace box.
  const captionBlock = (caption: string) =>
    `<pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#f4f2ec;border:1px solid #e0ddd2;border-radius:8px;padding:14px;margin:8px 0 0;color:#17363a">${escapeHtml(caption)}</pre>`;

  const btn = (href: string, label: string, bg: string, note?: string) =>
    `<div style="margin:0 0 12px 0">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 28px;background:${bg};color:#fff;font-weight:700;font-size:15px;border-radius:8px;text-decoration:none">${label}</a>` +
    (note ? `<div style="color:#5b6b6e;font-size:12px;margin-top:4px">${escapeHtml(note)}</div>` : ``) +
    `</div>`;

  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#17363a;max-width:680px">
  <h2 style="margin:0 0 4px">Calderyn — weekly social drop</h2>
  <div style="color:#5b6b6e;margin-bottom:18px">Week of ${escapeHtml(range)} · ${shippedCount} shipped · +${waitlistDelta} waitlist</div>

  <h3 style="margin:22px 0 2px;color:#1e7079">LinkedIn carousel</h3>
  ${imgRow(liUrls)}
  ${captionBlock(liCaption)}

  <h3 style="margin:28px 0 2px;color:#1e7079">Instagram carousel</h3>
  ${imgRow(igUrls)}
  ${captionBlock(igCaption)}

  <div style="margin-top:24px">
    ${approvals
      .map((a) =>
        btn(
          a.url,
          `Approve &amp; post — ${escapeHtml(a.label)}`,
          "#1a8a5a",
          "posts LinkedIn to your profile + gives you the Instagram slides",
        ),
      )
      .join("")}
  </div>

  <div style="margin-top:16px">
    ${btn(rejectUrl, "Reject &amp; regenerate for everyone", "#8a8a8a")}
  </div>
  <p style="color:#8a8a8a;font-size:13px;margin-top:22px">Auto-sent by the weekly social-digest cron. Links expire in 7 days.</p>
</div>`;

  const text = [
    `Calderyn — weekly social drop`,
    `Week of ${range} · ${shippedCount} shipped · +${waitlistDelta} waitlist`,
    ``,
    `--- LinkedIn caption ---`,
    liCaption,
    ``,
    `--- Instagram caption ---`,
    igCaption,
    ``,
    `APPROVE & POST (posts LinkedIn to your profile + gives you the Instagram slides):`,
    ...approvals.flatMap((a) => [`${a.label}:`, a.url]),
    ``,
    `REJECT & REGENERATE FOR EVERYONE:`,
    rejectUrl,
  ].join("\n");

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// sendDecisionEmail — shared by first-send (version 0) and regeneration.
// Mints signed preview URLs, approve/reject tokens, builds and sends the
// action email. Returns a DeliveryResult; never throws (returns not-configured
// or the sendEmail result directly).
// ---------------------------------------------------------------------------

interface SendDecisionEmailArgs {
  id: string;
  version: number;
  range: string;
  shippedCount: number;
  waitlistDelta: number;
  liPaths: string[];
  igPaths: string[];
  liCaption: string;
  igCaption: string;
  to: string[];
}

async function sendDecisionEmail(args: SendDecisionEmailArgs): Promise<DeliveryResult> {
  const { id, version, range, shippedCount, waitlistDelta, liPaths, igPaths, liCaption, igCaption, to } = args;

  let liUrls: string[];
  let igUrls: string[];
  try {
    [liUrls, igUrls] = await Promise.all([signedUrls(liPaths), signedUrls(igPaths)]);
  } catch (err) {
    return { sent: false, error: `signedUrls failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rejectToken = signActionToken(id, "reject", version);
  const baseUrl = process.env.SOCIAL_DIGEST_BASE_URL ?? "https://app.calderyncompany.com";
  // One combined "Approve & post" link per recipient, each bound to that founder's own
  // profile via the token's `owner` claim — posts LinkedIn + surfaces Instagram assets.
  const approvals = to.map((recipient) => {
    const token = signActionToken(id, "approve", version, { owner: recipient });
    return { label: recipient, url: `${baseUrl}/social/review/${id}?t=${token}` };
  });
  const rejectUrl = `${baseUrl}/social/review/${id}?t=${rejectToken}`;

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  if (!apiKey || !from) {
    const missing = [!apiKey && "RESEND_API_KEY", !from && "DIGEST_FROM"].filter(Boolean).join(", ");
    return { sent: false, error: `email not configured (${missing})` };
  }

  const { subject, text, html } = buildActionEmail({
    range,
    shippedCount,
    waitlistDelta,
    liUrls,
    igUrls,
    liCaption,
    igCaption,
    approvals,
    rejectUrl,
  });
  return sendEmail({ apiKey, from, to, subject, text, html });
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

  // Mint signed preview URLs, build and send the decision email.
  // version 0 = the row's regen_count at first send; a regeneration re-mints
  // tokens at the new version, invalidating this round's links.
  const delivery = await sendDecisionEmail({
    id,
    version: 0,
    range,
    shippedCount,
    waitlistDelta,
    liPaths,
    igPaths,
    liCaption: pack.linkedinCaption,
    igCaption: pack.instagramCaption,
    to,
  });

  // The email is the only way to act on this drop; if it didn't send, the row
  // must not linger as 'pending' (it would look like it's awaiting a decision).
  if (!delivery.sent) await markDigestFailed(id);

  return {
    digestId: id,
    status: delivery.sent ? "pending" : "error",
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

// ---------------------------------------------------------------------------
// regenerateDigest — reusable engine called by the reject POST handler.
// Loads the existing row, enforces the regen cap, re-collects activity for
// the same week, rebuilds copy+slides with variation context, updates the row,
// and re-emails the decision email at the new version. Never throws — every
// failure mode returns {ok:false, error}.
// ---------------------------------------------------------------------------

/** Minimal shape of a social_digest row as returned by Supabase. */
interface SocialDigestRow {
  id: string;
  week_range: string;
  since_iso: string;
  regen_count: number;
  pack_json: SocialPack;
  prior_copy_json: string[];
  li_image_paths: string[];
  ig_image_paths: string[];
}

export interface RegenerateResult {
  ok: boolean;
  capped?: boolean;
  newVersion?: number;
  delivery?: DeliveryResult;
  error?: string;
}

export async function regenerateDigest(
  id: string,
  variation: { reasons: string[]; note?: string },
): Promise<RegenerateResult> {
  // 1. Load the row.
  let row: SocialDigestRow;
  try {
    const { data, error } = await getSupabase()
      .from("social_digest")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) {
      return { ok: false, error: `Row not found: ${error?.message ?? "no data"}` };
    }
    // Narrow from unknown — validate the fields we depend on.
    const r = data as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.week_range !== "string" ||
      typeof r.since_iso !== "string" ||
      typeof r.regen_count !== "number" ||
      typeof r.pack_json !== "object" || r.pack_json === null ||
      !Array.isArray(r.prior_copy_json) ||
      !Array.isArray(r.li_image_paths) ||
      !Array.isArray(r.ig_image_paths)
    ) {
      return { ok: false, error: "Row shape unexpected — cannot regenerate" };
    }
    row = r as unknown as SocialDigestRow;
  } catch (err) {
    return { ok: false, error: `DB load failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 2. Cap check.
  if (row.regen_count >= MAX_REGENS) {
    return { ok: false, capped: true };
  }

  // 3. Re-collect activity for the same week.
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, error: "GITHUB_TOKEN is not set" };
  }
  const repo = process.env.DIGEST_REPO ?? DEFAULT_REPO;
  const sinceMs = Date.parse(row.since_iso);

  let activity;
  try {
    activity = await collectActivity({ repo, token, sinceMs });
  } catch (err) {
    return { ok: false, error: `collect failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const shippedCount = activity.mergedPRs.length;
  let waitlistDelta = 0;
  try {
    const waitlist = await collectWaitlistSignups({ sinceMs });
    waitlistDelta = waitlist.signups.length;
  } catch {
    // a waitlist hiccup shouldn't sink regeneration — treat as 0 new this week
  }

  // 4. Build priorCopy = stored (string-validated) prior_copy_json +
  // extractPriorCopy(current pack), deduped. A malformed pack_json must not crash
  // the regen — fall back to no prior-copy avoidance.
  const priorStrings = (row.prior_copy_json as unknown[]).filter(
    (x): x is string => typeof x === "string",
  );
  const seen = new Set<string>(priorStrings);
  const priorCopy: string[] = [...priorStrings];
  try {
    for (const s of extractPriorCopy(row.pack_json)) {
      if (!seen.has(s)) {
        seen.add(s);
        priorCopy.push(s);
      }
    }
  } catch {
    // pack_json not a well-formed SocialPack — regenerate without avoidance hints
  }

  // 5. Build new pack with variation context.
  let pack: SocialPack;
  try {
    ({ pack } = await buildSocialPack({
      activity,
      range: row.week_range,
      shippedCount,
      waitlistDelta,
      variation: { reasons: variation.reasons, note: variation.note, priorCopy },
    }));
  } catch (err) {
    return { ok: false, error: `buildSocialPack failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 6. Render + store slides (upsert overwrites the same paths).
  let liPaths: string[];
  let igPaths: string[];
  try {
    const { linkedinHtml, instagramHtml } = buildCarousels(pack);
    const [liShots, igShots] = await renderSlideSets([linkedinHtml, instagramHtml]);
    ({ liPaths, igPaths } = await storeSlides(id, liShots, igShots));
  } catch (err) {
    return { ok: false, error: `render/store failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 7. New version = regen_count + 1.
  const newVersion = row.regen_count + 1;

  // 8. Update the row.
  try {
    const { error: updateError } = await getSupabase()
      .from("social_digest")
      .update({
        regen_count: newVersion,
        pack_json: pack,
        li_caption: pack.linkedinCaption,
        ig_caption: pack.instagramCaption,
        li_image_paths: liPaths,
        ig_image_paths: igPaths,
        prior_copy_json: priorCopy,
        consumed_at: null,
        status: "pending",
        acted_at: new Date().toISOString(),
        li_posted_at: null,
      })
      .eq("id", id);
    if (updateError) {
      return { ok: false, error: `DB update failed: ${updateError.message}` };
    }
  } catch (err) {
    return { ok: false, error: `DB update failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 8b. Clear per-founder claim rows for this drop so the new version is approvable
  //     fresh. Best-effort: a delete failure must not block the email re-send.
  try {
    const { error: deleteError } = await getSupabase()
      .from("social_link_post")
      .delete()
      .eq("digest_id", id);
    if (deleteError) {
      console.error("[regenerateDigest] social_link_post delete failed:", id, deleteError.message);
    }
  } catch (deleteErr) {
    console.error("[regenerateDigest] social_link_post delete threw:", id, deleteErr);
  }

  // 9. Send decision email at the new version (invalidates the previous round's links).
  const delivery = await sendDecisionEmail({
    id,
    version: newVersion,
    range: row.week_range,
    shippedCount,
    waitlistDelta,
    liPaths,
    igPaths,
    liCaption: pack.linkedinCaption,
    igCaption: pack.instagramCaption,
    to: recipients(),
  });

  // 10. Return result.
  return { ok: true, newVersion, delivery };
}
