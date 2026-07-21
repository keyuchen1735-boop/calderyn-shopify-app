// Polite HTTP for competitor snapshots: honest UA, hard 5s timeout, ~1MB cap
// (content-length check AND a streaming reader loop), and a deliberately
// conservative robots.txt matcher (Disallow-only; ignoring Allow lines can
// only make us fetch LESS). fetchImpl is injectable so tests never hit the
// network.

export const RADAR_USER_AGENT = "CalderynRadar/1.0 (+https://calderyncompany.com)";
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 1_000_000;

export type PoliteFetchResult =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; error: string; reason?: string };

function getOrigin(urlStr: string): string {
  try {
    return new URL(urlStr).origin;
  } catch {
    return "";
  }
}

export async function politeFetch(
  url: string,
  fetchImpl: typeof fetch = fetch,
  hops: number = 0
): Promise<PoliteFetchResult> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        "user-agent": RADAR_USER_AGENT,
        accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Handle redirects manually
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        return { ok: false, status: res.status, error: `redirect without Location header`, reason: "invalid_redirect" };
      }

      // Check if we've already followed too many hops
      if (hops >= 3) {
        return { ok: false, status: res.status, error: `too many redirects`, reason: "too_many_redirects" };
      }

      // Resolve Location relative to current URL
      let nextUrl: string;
      try {
        nextUrl = new URL(location, url).href;
      } catch {
        return { ok: false, status: res.status, error: `invalid Location header`, reason: "invalid_redirect" };
      }

      // Check if redirect is same-origin
      const currentOrigin = getOrigin(url);
      const nextOrigin = getOrigin(nextUrl);
      if (currentOrigin !== nextOrigin) {
        return {
          ok: false,
          status: res.status,
          error: `cross-host redirect to ${nextOrigin}`,
          reason: "cross_host_redirect",
        };
      }

      // Follow the same-origin redirect recursively
      return politeFetch(nextUrl, fetchImpl, hops + 1);
    }

    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) {
      return { ok: false, status: res.status, error: `response too large (${declared} bytes declared)` };
    }
    const text = await readCapped(res);
    if (text === null) {
      return { ok: false, status: res.status, error: `response too large (exceeded ${MAX_RESPONSE_BYTES} bytes)` };
    }
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read at most MAX_RESPONSE_BYTES; null when the body exceeds the cap. */
async function readCapped(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    return text.length > MAX_RESPONSE_BYTES ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export interface RobotsRules {
  /** Disallow path prefixes that apply to CalderynRadar. */
  disallow: string[];
  /** True when robots.txt could not be read (5xx/network): skip the host tonight. */
  unreachable: boolean;
}

/** Disallow-only parser: a group naming calderynradar wins over the `*` group. */
export function parseRobots(text: string): RobotsRules {
  const groups: Array<{ agents: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; disallow: string[] } | null = null;
  let inAgentRun = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "user-agent") {
      if (!current || !inAgentRun) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      inAgentRun = true;
      current.agents.push(value.toLowerCase());
    } else {
      inAgentRun = false;
      if (current && field === "disallow" && value) current.disallow.push(value);
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a === "calderynradar"));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = specific.length > 0 ? specific : wildcard;
  return { disallow: chosen.flatMap((g) => g.disallow), unreachable: false };
}

export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  if (rules.unreachable) return false;
  return !rules.disallow.some((prefix) => path.startsWith(prefix));
}

/** 2xx -> parse; 4xx -> allow-all; 5xx/network/timeout -> disallow-all tonight. */
export async function loadRobots(origin: string, fetchImpl: typeof fetch = fetch): Promise<RobotsRules> {
  const res = await politeFetch(`${origin.replace(/\/+$/, "")}/robots.txt`, fetchImpl);
  if (res.ok) return parseRobots(res.text);
  if (res.status !== undefined && res.status >= 400 && res.status < 500) {
    return { disallow: [], unreachable: false };
  }
  return { disallow: [], unreachable: true };
}
