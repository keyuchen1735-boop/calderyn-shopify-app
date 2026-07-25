// app/lib/github-digest/collect.server.ts
//
// GitHub activity collector for the daily progress digest (see cron.github-digest.tsx).
//
// Talks to the GitHub REST API directly over `fetch` — no octokit dependency.
// Collects three things from a trailing 24h window:
//   1. Commits authored in the window across ALL branches. The REST commits
//      endpoint is per-ref, so we enumerate branches and fetch each branch's
//      recent commits, deduping by SHA (a commit on three branches is ONE
//      entry, tagged with the first branch we saw it on). Branch scan is bounded
//      by `maxBranches`; if the repo has more, that's recorded in `notes` and
//      surfaced — never silently dropped (rule 12).
//   2. Pull requests MERGED in the window (the landed work).
//   3. Pull requests OPENED in the window (in-flight work), excluding any that
//      already appear under merged so a PR is never listed twice.
//
// PRs use the Search API, which has first-class date qualifiers; commits use
// the per-branch listing because commit-search only indexes the default branch.

const GITHUB_API = "https://api.github.com";
// One GET per branch; 100 keeps a daily run well within the function timeout
// while covering the repo's branch count with headroom. Anything beyond is
// recorded in `notes` (never silently dropped).
const DEFAULT_MAX_BRANCHES = 100;

export interface CommitInfo {
  sha: string;
  /** First line of the commit message (subject). */
  subject: string;
  /** Display name from the commit (git author.name). */
  author: string;
  /** GitHub account login that authored the commit (""→ unknown) — used for attribution. */
  login: string;
  branch: string;
  isoDate: string;
  /** Owner/name of the repo this commit came from — attribution when several are tracked. */
  repo: string;
}

export interface PullInfo {
  number: number;
  title: string;
  /** Body, trimmed and length-capped for prompt/email sanity. */
  body: string;
  author: string;
  url: string;
  /** Owner/name of the repo this PR came from — attribution when several are tracked. */
  repo: string;
}

export interface Activity {
  /** Human-readable label: a single "owner/name", or a comma-joined list. */
  repo: string;
  /** Every repo this activity covers, in configured order. */
  repos: string[];
  sinceIso: string;
  commits: CommitInfo[];
  mergedPRs: PullInfo[];
  openedPRs: PullInfo[];
  branchesScanned: number;
  branchesTotal: number;
  /** Non-fatal warnings (truncation, partial failures) — surfaced, not swallowed. */
  notes: string[];
}

interface GhBranch {
  name: string;
}
interface GhCommitListItem {
  sha: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
  author: { login?: string } | null;
}
interface GhSearchItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login?: string } | null;
}
interface GhSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GhSearchItem[];
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "calderyn-github-digest",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: headers(token) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `GitHub ${path} -> ${res.status} ${res.statusText} ${detail.slice(0, 200)}`,
    );
  }
  return (await res.json()) as unknown;
}

function firstLine(message: string): string {
  const nl = message.indexOf("\n");
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}

function capBody(body: string | null): string {
  const text = (body ?? "").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

async function listBranchNames(repo: string, token: string): Promise<string[]> {
  // One page (100) is plenty for the digest; deeper pagination is not worth the
  // extra calls for a daily summary.
  const raw = await ghGet(`/repos/${repo}/branches?per_page=100`, token);
  if (!Array.isArray(raw)) return [];
  return (raw as GhBranch[]).map((b) => b.name).filter((n): n is string => typeof n === "string");
}

async function commitsForBranch(
  repo: string,
  branch: string,
  sinceIso: string,
  token: string,
): Promise<GhCommitListItem[]> {
  const q = `sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(sinceIso)}&per_page=100`;
  const raw = await ghGet(`/repos/${repo}/commits?${q}`, token);
  return Array.isArray(raw) ? (raw as GhCommitListItem[]) : [];
}

async function searchPRs(
  repo: string,
  qualifier: string,
  token: string,
): Promise<GhSearchItem[]> {
  const q = encodeURIComponent(`repo:${repo} is:pr ${qualifier}`);
  const raw = await ghGet(`/search/issues?q=${q}&per_page=50`, token);
  const parsed = raw as GhSearchResponse;
  return Array.isArray(parsed?.items) ? parsed.items : [];
}

function toPull(item: GhSearchItem, repo: string): PullInfo {
  return {
    number: item.number,
    title: item.title,
    body: capBody(item.body),
    author: item.user?.login ?? "unknown",
    url: item.html_url,
    repo,
  };
}

export async function collectActivity(opts: {
  repo: string;
  token: string;
  sinceMs: number;
  maxBranches?: number;
}): Promise<Activity> {
  const { repo, token } = opts;
  const maxBranches = opts.maxBranches ?? DEFAULT_MAX_BRANCHES;
  const sinceIso = new Date(opts.sinceMs).toISOString();
  const notes: string[] = [];

  // --- Commits across all branches (deduped by SHA) ---
  const allBranches = await listBranchNames(repo, token);
  const branchesTotal = allBranches.length;
  const scanned = allBranches.slice(0, maxBranches);
  if (branchesTotal > scanned.length) {
    notes.push(
      `Scanned ${scanned.length} of ${branchesTotal} branches (capped at ${maxBranches}); some branch commits may be omitted.`,
    );
  }

  const bySha = new Map<string, CommitInfo>();
  for (const branch of scanned) {
    let items: GhCommitListItem[];
    try {
      items = await commitsForBranch(repo, branch, sinceIso, token);
    } catch (err) {
      // One bad branch must not sink the whole digest — record and continue.
      notes.push(`Branch "${branch}" commit fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const it of items) {
      if (bySha.has(it.sha)) continue;
      bySha.set(it.sha, {
        sha: it.sha,
        subject: firstLine(it.commit?.message ?? ""),
        author: it.commit?.author?.name ?? it.author?.login ?? "unknown",
        login: it.author?.login ?? "",
        branch,
        isoDate: it.commit?.author?.date ?? "",
        repo,
      });
    }
  }
  const commits = [...bySha.values()].sort((a, b) => b.isoDate.localeCompare(a.isoDate));

  // --- PRs merged / opened in the window ---
  // Resilient like the per-branch commit fetch above: a search failure (rate
  // limit, transient 5xx, qualifier rejection) degrades to "PRs unavailable"
  // plus a note — it must NOT discard the commits already collected (rule 12).
  let mergedPRs: PullInfo[] = [];
  let openedPRs: PullInfo[] = [];
  try {
    const mergedItems = await searchPRs(repo, `merged:>=${sinceIso}`, token);
    const openedItems = await searchPRs(repo, `created:>=${sinceIso}`, token);
    mergedPRs = mergedItems.map((i) => toPull(i, repo));
    const mergedNums = new Set(mergedPRs.map((p) => p.number));
    openedPRs = openedItems.map((i) => toPull(i, repo)).filter((p) => !mergedNums.has(p.number));
  } catch (err) {
    notes.push(`Pull-request lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    repo,
    repos: [repo],
    sinceIso,
    commits,
    mergedPRs,
    openedPRs,
    branchesScanned: scanned.length,
    branchesTotal,
    notes,
  };
}

/**
 * Parse the `DIGEST_REPO` env value into a repo list. Accepts one repo or
 * several separated by commas/whitespace ("a/b, c/d"), trims blanks, and drops
 * duplicates while preserving configured order.
 */
export function parseRepoList(raw: string | undefined): string[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

/** Short display label for a repo: "owner/name" -> "name". */
export function repoLabel(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash === -1 ? repo : repo.slice(slash + 1);
}

export interface MultiRepoActivity {
  /** All repos' activity merged into one, for grouping/summarizing/rendering. */
  merged: Activity;
  /** Per-repo activity in configured order — repos that failed entirely are absent. */
  perRepo: Activity[];
}

/**
 * Collect activity across several repos and merge it into a single Activity.
 *
 * Repos are fetched sequentially to stay friendly to GitHub's secondary rate
 * limits on a shared token. One repo failing outright (bad name, revoked
 * access, rate limit) degrades to a surfaced note and the remaining repos still
 * report — it never sinks the whole digest (rule 12). Every note is prefixed
 * with its repo so a partial result is never mistaken for a complete one.
 */
export async function collectMultiRepoActivity(opts: {
  repos: string[];
  token: string;
  sinceMs: number;
  maxBranches?: number;
}): Promise<MultiRepoActivity> {
  const { repos, token, sinceMs, maxBranches } = opts;
  const sinceIso = new Date(sinceMs).toISOString();
  const perRepo: Activity[] = [];
  const notes: string[] = [];

  for (const repo of repos) {
    try {
      const activity = await collectActivity({ repo, token, sinceMs, maxBranches });
      perRepo.push(activity);
      // Prefix so a note reads unambiguously once several repos are merged.
      for (const n of activity.notes) notes.push(repos.length > 1 ? `${repo}: ${n}` : n);
    } catch (err) {
      notes.push(`${repo}: activity unavailable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const commits = perRepo
    .flatMap((a) => a.commits)
    .sort((a, b) => b.isoDate.localeCompare(a.isoDate));

  const merged: Activity = {
    repo: repos.join(", "),
    repos,
    sinceIso,
    commits,
    mergedPRs: perRepo.flatMap((a) => a.mergedPRs),
    openedPRs: perRepo.flatMap((a) => a.openedPRs),
    branchesScanned: perRepo.reduce((n, a) => n + a.branchesScanned, 0),
    branchesTotal: perRepo.reduce((n, a) => n + a.branchesTotal, 0),
    notes,
  };

  return { merged, perRepo };
}
