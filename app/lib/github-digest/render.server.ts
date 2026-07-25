// app/lib/github-digest/render.server.ts
//
// Renders the digest as a branded HTML email (with a plaintext twin) and
// attributes work per person. Pure functions — no env, no network — so the
// classification and rendering are unit-tested directly.
//
// Brand tokens mirror app/styles/dashboard.css (the Calderyn design system):
//   accent #24556E (teal) is primary; #c96442 (terracotta) is the secondary.
// People are color-coded so "who did what" reads at a glance: Eric = teal,
// John = terracotta, anyone else = neutral grey.

import { repoLabel, type Activity, type CommitInfo, type PullInfo } from "./collect.server";
import type { WaitlistSignup } from "./waitlist.server";

const BRAND = {
  accent: "#24556E",
  terracotta: "#c96442",
  bg: "#F5F5F7",
  card: "#FFFFFF",
  text1: "#1D1D1F",
  text2: "#6E6E73",
  text3: "#AEAEB2",
  green: "#248A3D",
  border: "#E5E5EA",
  // Logo mark colors (mirror app/lib/favicon.server.ts: navy square + mint "C").
  navy: "#1a1a2e",
  mint: "#7ee0c3",
} as const;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function repoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

/** Repos covered by this digest, falling back to the single `repo` label. */
function repoList(activity: Activity): string[] {
  return activity.repos?.length ? activity.repos : [activity.repo].filter(Boolean);
}

export interface Actor {
  key: string;
  label: string;
  login: string;
  color: string;
}

/** Map a commit/PR identity to a known person (Eric / John) or a neutral fallback. */
export function classifyActor(ident: { login?: string; name?: string }): Actor {
  const hay = `${ident.login ?? ""} ${ident.name ?? ""}`.toLowerCase();
  if (/keyuch|eric/.test(hay)) {
    return { key: "eric", label: "Eric", login: "keyuchen1735-boop", color: BRAND.accent };
  }
  if (/mezoh|john|duncan/.test(hay)) {
    return { key: "john", label: "John", login: "mezohyt-3164", color: BRAND.terracotta };
  }
  const label = ident.name || ident.login || "Other";
  return { key: (ident.login || label).toLowerCase(), label, login: ident.login || "", color: BRAND.text2 };
}

export interface PersonGroup {
  actor: Actor;
  commits: CommitInfo[];
  mergedPRs: PullInfo[];
  openedPRs: PullInfo[];
}

/** Group all activity by person, ordered Eric, John, then others by volume. */
export function groupByActor(activity: Activity): PersonGroup[] {
  const map = new Map<string, PersonGroup>();
  const ensure = (actor: Actor): PersonGroup => {
    const g = map.get(actor.key) ?? { actor, commits: [], mergedPRs: [], openedPRs: [] };
    map.set(actor.key, g);
    return g;
  };
  for (const c of activity.commits) ensure(classifyActor({ login: c.login, name: c.author })).commits.push(c);
  for (const p of activity.mergedPRs) ensure(classifyActor({ login: p.author })).mergedPRs.push(p);
  for (const p of activity.openedPRs) ensure(classifyActor({ login: p.author })).openedPRs.push(p);

  const rank = (k: string) => (k === "eric" ? 0 : k === "john" ? 1 : 2);
  return [...map.values()].sort((a, b) => {
    const d = rank(a.actor.key) - rank(b.actor.key);
    if (d !== 0) return d;
    return b.commits.length + b.mergedPRs.length - (a.commits.length + a.mergedPRs.length);
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Email-safe brand logo lockup: a navy rounded-square badge lettered with the
// brand's first initial (a CSS recreation of the SVG favicon mark, since email
// clients strip SVG/data-URIs) next to the wordmark.
function logoLockup(brand: string): string {
  const initial = esc(brand.charAt(0).toUpperCase() || "?");
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle">
      <div style="width:34px;height:34px;border-radius:9px;background:${BRAND.navy};text-align:center;line-height:34px;font-family:${FONT};font-weight:800;font-size:20px;color:${BRAND.mint}">${initial}</div>
    </td>
    <td style="vertical-align:middle;padding-left:11px;font-size:21px;font-weight:750;color:${BRAND.navy};letter-spacing:-0.02em">${esc(brand)}</td>
  </tr></table>`;
}

export interface RenderInput {
  dateLabel: string;
  /** Brand name for the header lockup and footer (defaults to "Calderyn"). */
  brand: string;
  /** Plain-English overview of the whole day (may be empty). */
  overview: string;
  /** actor.key -> one-line plain-English summary of what they did (may be absent). */
  prose: Record<string, string>;
  /** New waitlist signups in the digest window (may be absent/empty). */
  signups?: WaitlistSignup[];
}

// When the digest tracks several repos, each PR carries a small repo chip so
// "who did what" stays readable across products; with one repo it is redundant.
function prLine(p: PullInfo, showRepo: boolean): { html: string; text: string } {
  const label = p.repo ? repoLabel(p.repo) : "";
  const chipHtml =
    showRepo && label
      ? ` <span style="display:inline-block;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:5px;padding:1px 6px;font-size:11px;color:${BRAND.text2};font-weight:600">${esc(label)}</span>`
      : "";
  const chipText = showRepo && label ? ` [${label}]` : "";
  return {
    html: `<a href="${esc(p.url)}" style="color:${BRAND.accent};text-decoration:none;font-weight:600">#${p.number}</a> <span style="color:${BRAND.text1}">${esc(p.title)}</span>${chipHtml}`,
    text: `#${p.number} ${p.title}${chipText}`,
  };
}

function personMeta(g: PersonGroup): string {
  const bits: string[] = [];
  if (g.commits.length) bits.push(`${g.commits.length} commit${g.commits.length === 1 ? "" : "s"}`);
  if (g.mergedPRs.length) bits.push(`${g.mergedPRs.length} merged`);
  if (g.openedPRs.length) bits.push(`${g.openedPRs.length} opened`);
  return bits.join(" · ");
}

/**
 * Per-repo commit split for one person, e.g. "hive-mind 8 · amoeba-landing-page 3".
 * Returns "" for a single-repo digest (where the split says nothing) or when the
 * person's commits all landed in one repo anyway.
 */
function personRepoSplit(g: PersonGroup, repos: string[]): string {
  if (repos.length < 2) return "";
  const counts = new Map<string, number>();
  for (const c of g.commits) {
    if (!c.repo) continue;
    counts.set(c.repo, (counts.get(c.repo) ?? 0) + 1);
  }
  for (const p of [...g.mergedPRs, ...g.openedPRs]) {
    if (!p.repo) continue;
    if (!counts.has(p.repo)) counts.set(p.repo, 0);
  }
  if (counts.size < 2) return "";
  return repos
    .filter((r) => counts.has(r))
    .map((r) => `${repoLabel(r)} ${counts.get(r)}`)
    .join(" · ");
}

// Local-parts that are role/non-personal mailboxes — we lead with the email
// for these instead of inventing a person's name.
const ROLE_LOCAL = /^(info|hello|team|admin|support|sales|contact|hi|hey|mail|e?mail|help|press|founders?|billing|accounts?|office|no-?reply|do-?not-?reply)$/i;

/**
 * Best-effort display name derived from an email's local-part:
 *   jane.doe@x.com -> "Jane Doe", john_smith@x -> "John Smith".
 * Returns null when the local-part isn't humanizable (role mailbox like info@,
 * or alphanumeric noise like x7y@) so the caller can lead with the email.
 */
export function deriveDisplayName(email: string): string | null {
  const local = (email.split("@")[0] ?? "").split("+")[0];
  if (ROLE_LOCAL.test(local)) return null;
  const tokens = local.split(/[._-]+/).filter((t) => /^[a-zA-Z]{2,}$/.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join(" ");
}

/** Short "Jun 13, 2:30 PM ET" stamp for a signup; "" if the ISO is unparseable. */
function signupTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))} ET`;
}

/** One signup row: name (or email) headline + a meta line of the rest. */
function signupRowHtml(s: WaitlistSignup): string {
  const name = deriveDisplayName(s.email);
  const headline = name ?? s.email;
  const initial = esc(headline.charAt(0).toUpperCase() || "?");
  const meta: string[] = [];
  if (name) meta.push(esc(s.email));
  if (s.phone) meta.push(esc(s.phone));
  if (s.referredBy) meta.push(`referred by ${esc(s.referredBy)}`);
  const when = signupTime(s.createdAtIso);
  if (when) meta.push(esc(when));
  const metaHtml = meta.length
    ? `<div style="margin-top:2px;color:${BRAND.text2};font-size:13px;line-height:1.5">${meta.join(" · ")}</div>`
    : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>
      <td width="36" valign="top">
        <div style="width:28px;height:28px;border-radius:50%;background:${BRAND.green};color:#fff;font-weight:700;font-size:13px;text-align:center;line-height:28px;font-family:${FONT}">${initial}</div>
      </td>
      <td valign="top" style="padding-left:11px">
        <div style="font-size:15px;font-weight:600;color:${BRAND.text1};letter-spacing:-0.01em">${esc(headline)}</div>
        ${metaHtml}
      </td>
    </tr></table>`;
}

/** "New waitlist signups" card section; "" when there are none (no empty block). */
function waitlistSectionHtml(signups: WaitlistSignup[]): string {
  if (signups.length === 0) return "";
  const rows = signups.map(signupRowHtml).join("");
  return `
    <tr><td style="padding:6px 26px 8px">
      <div style="border-top:1px solid ${BRAND.border};padding-top:18px">
        <div style="font-size:13px;font-weight:700;color:${BRAND.text1};letter-spacing:-0.01em">New waitlist signups<span style="color:${BRAND.green};font-weight:700"> · ${signups.length}</span></div>
        ${rows}
      </div>
    </td></tr>`;
}

/** Branded HTML email. Table + inline-style layout for broad email-client support. */
export function renderHtml(activity: Activity, groups: PersonGroup[], input: RenderInput): string {
  const repos = repoList(activity);
  const multiRepo = repos.length > 1;
  const personBlocks = groups
    .map((g) => {
      const initial = esc(g.actor.label.charAt(0).toUpperCase() || "?");
      const prose = input.prose[g.actor.key];
      const proseHtml = prose
        ? `<p style="margin:6px 0 0;color:${BRAND.text2};font-size:14px;line-height:1.5">${esc(prose)}</p>`
        : "";
      const split = personRepoSplit(g, repos);
      const splitHtml = split
        ? `<div style="margin-top:4px;font-size:12px;color:${BRAND.text3}">${esc(split)}</div>`
        : "";
      const merged = g.mergedPRs.slice(0, 8).map((p) => prLine(p, multiRepo));
      const moreMerged = g.mergedPRs.length > merged.length ? `<div style="color:${BRAND.text3};font-size:13px;margin-top:4px">+${g.mergedPRs.length - merged.length} more</div>` : "";
      const mergedHtml = merged.length
        ? `<div style="margin-top:10px">${merged
            .map((m) => `<div style="font-size:14px;line-height:1.7">${m.html}</div>`)
            .join("")}${moreMerged}</div>`
        : "";
      return `
      <tr><td style="padding:18px 0;border-top:1px solid ${BRAND.border}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="40" valign="top">
            <div style="width:32px;height:32px;border-radius:50%;background:${g.actor.color};color:#fff;font-weight:700;font-size:15px;text-align:center;line-height:32px;font-family:${FONT}">${initial}</div>
          </td>
          <td valign="top" style="padding-left:12px">
            <div style="font-size:16px;font-weight:650;color:${BRAND.text1};letter-spacing:-0.01em">${esc(g.actor.label)}<span style="color:${BRAND.text3};font-weight:500;font-size:13px"> · ${esc(personMeta(g)) || "no changes"}</span></div>
            ${splitHtml}
            ${proseHtml}
            ${mergedHtml}
          </td>
        </tr></table>
      </td></tr>`;
    })
    .join("");

  const overviewHtml = input.overview
    ? `<p style="margin:0 0 4px;color:${BRAND.text1};font-size:15px;line-height:1.6">${esc(input.overview)}</p>`
    : "";

  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.bg}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;font-family:${FONT}">
        <tr><td style="height:4px;background:${BRAND.accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:22px 28px 6px">
          <table role="presentation" width="100%"><tr>
            <td style="vertical-align:middle">${logoLockup(input.brand)}</td>
            <td align="right" style="font-size:13px;color:${BRAND.text3};vertical-align:middle">${esc(input.dateLabel)}</td>
          </tr></table>
          <div style="font-size:13px;color:${BRAND.text2};margin-top:6px">Daily dev digest</div>
        </td></tr>
        <tr><td style="padding:10px 26px 4px">${overviewHtml}</td></tr>
        <tr><td style="padding:0 26px 8px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${personBlocks}</table>
        </td></tr>
        ${waitlistSectionHtml(input.signups ?? [])}
        <tr><td style="padding:16px 26px 24px;border-top:1px solid ${BRAND.border}">
          <div style="font-size:12px;color:${BRAND.text3}">Automated daily digest · ${repos
            .map((r) => `<a href="${esc(repoUrl(r))}" style="color:${BRAND.text3}">${esc(repoLabel(r))}</a>`)
            .join(" · ")}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

/** Plaintext twin for clients that don't render HTML. */
export function renderText(activity: Activity, groups: PersonGroup[], input: RenderInput): string {
  const repos = repoList(activity);
  const multiRepo = repos.length > 1;
  const lines: string[] = [`${input.brand.toUpperCase()} — Daily dev digest`, input.dateLabel, ""];
  if (input.overview) lines.push(input.overview, "");
  for (const g of groups) {
    lines.push(`${g.actor.label} (${personMeta(g) || "no changes"})`);
    const split = personRepoSplit(g, repos);
    if (split) lines.push(`  ${split}`);
    const prose = input.prose[g.actor.key];
    if (prose) lines.push(`  ${prose}`);
    const merged = g.mergedPRs.slice(0, 8);
    for (const p of merged) lines.push(`  merged ${prLine(p, multiRepo).text}`);
    if (g.mergedPRs.length > merged.length) lines.push(`  +${g.mergedPRs.length - merged.length} more merged`);
    lines.push("");
  }
  const signups = input.signups ?? [];
  if (signups.length) {
    lines.push(`New waitlist signups (${signups.length})`);
    for (const s of signups) {
      const name = deriveDisplayName(s.email);
      const bits = [s.phone, s.referredBy ? `referred by ${s.referredBy}` : "", signupTime(s.createdAtIso)].filter(Boolean);
      const tail = bits.length ? ` · ${bits.join(" · ")}` : "";
      lines.push(name ? `  ${name} — ${s.email}${tail}` : `  ${s.email}${tail}`);
    }
    lines.push("");
  }
  for (const n of activity.notes) lines.push(`Note: ${n}`);
  lines.push("", `Automated daily digest · ${repos.map(repoUrl).join(" · ")}`);
  return lines.join("\n").trimEnd();
}

/** Branded "quiet day" card. */
export function renderEmptyHtml(dateLabel: string, brand: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BRAND.bg}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:16px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;font-family:${FONT}">
      <tr><td style="height:4px;background:${BRAND.accent};font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:22px 28px">
        ${logoLockup(brand)}
        <div style="font-size:13px;color:${BRAND.text2};margin-top:6px">Daily dev digest · ${esc(dateLabel)}</div>
        <p style="margin:16px 0 0;color:${BRAND.text1};font-size:15px">No commits or pull requests in the last 24 hours.</p>
      </td></tr>
    </table>
  </td></tr></table>
  </body></html>`;
}
