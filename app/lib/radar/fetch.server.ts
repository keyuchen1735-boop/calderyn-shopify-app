// Polite HTTP for competitor snapshots: honest UA, hard 5s timeout, ~1MB cap
// (content-length check AND a streaming reader loop), and a deliberately
// conservative robots.txt matcher (Disallow-only; ignoring Allow lines can
// only make us fetch LESS). fetchImpl is injectable so tests never hit the
// network.

export const RADAR_USER_AGENT = "CalderynRadar/1.0 (+https://calderyncompany.com)";
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 1_000_000;
/** Overall wall-clock cap across a full redirect chain (all hops combined).
 *  Without this, a 4-hop chain at FETCH_TIMEOUT_MS per hop could take ~20s. */
export const REDIRECT_CHAIN_DEADLINE_MS = 12_000;

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

/** IPv4 literal check for the private/reserved ranges an SSRF-hardened
 *  fetcher must refuse: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
 *  and the 0.0.0.0 "this network" address. */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 && b === 0 && nums[2] === 0 && nums[3] === 0) return true;
  return false;
}

/** Shared SSRF guard: true only for an https URL whose hostname is a real,
 *  publicly routable name/address - never localhost, a private/reserved
 *  IPv4 literal, any IPv6 literal, or a .internal/.local suffixed host.
 *  Used both to filter model-suggested competitor URLs (normalizeOrigin)
 *  and as the first check inside politeFetch itself. */
export function isPubliclyRoutableHttps(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const hostname = u.hostname.toLowerCase();
  if (hostname === "localhost") return false;
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
  // Bracketed IPv6 literals ("[::1]", "[2001:db8::1]") - URL.hostname keeps
  // the brackets for IPv6 hosts, which is what marks it as a literal here.
  if (hostname.startsWith("[") && hostname.endsWith("]")) return false;
  if (isPrivateIPv4(hostname)) return false;
  return true;
}

export async function politeFetch(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<PoliteFetchResult> {
  if (!isPubliclyRoutableHttps(url)) {
    return { ok: false, error: "blocked private/loopback/internal target", reason: "blocked_host" };
  }
  return fetchWithRedirects(url, fetchImpl, 0, Date.now() + REDIRECT_CHAIN_DEADLINE_MS);
}

// Hop counting stays module-private so the 3-hop cap is an enforced
// invariant, not a caller-overridable parameter. Each hop re-applies the
// full politeness set (UA, per-hop 5s timeout, size cap on the final
// response). The redirect target is already origin-pinned (see the
// cross-host check below), so the SSRF host guard only needs to run once,
// at entry in politeFetch - it is not re-checked per hop. `deadline` is an
// overall wall-clock cap threaded across every hop of one chain so a
// max-length chain can't take ~4x the per-hop timeout.
async function fetchWithRedirects(
  url: string,
  fetchImpl: typeof fetch,
  hops: number,
  deadline: number
): Promise<PoliteFetchResult> {
  if (Date.now() >= deadline) {
    return { ok: false, error: "redirect chain exceeded the overall wall-clock cap", reason: "timeout" };
  }
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
      return fetchWithRedirects(nextUrl, fetchImpl, hops + 1, deadline);
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
