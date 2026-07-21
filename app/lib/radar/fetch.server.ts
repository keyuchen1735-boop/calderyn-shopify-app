// Polite HTTP for competitor snapshots: honest UA, hard 5s timeout, ~1MB cap
// (content-length check AND a streaming reader loop), and a deliberately
// conservative robots.txt matcher (Disallow-only; ignoring Allow lines can
// only make us fetch LESS). fetchImpl is injectable so tests never hit the
// network.
//
// SSRF defense has two layers because hostname-string inspection alone
// cannot see through DNS: a wildcard-DNS name like "169.254.169.254.xip.io"
// looks like a normal public hostname yet resolves straight to the cloud
// metadata address. Layer 1 (isPubliclyRoutableHttps) is a cheap sync string
// guard. Layer 2 (this file's DNS-resolve + IP-validate step, threaded via an
// injectable `resolve` so tests stay network-free) resolves the real
// address(es) and rejects any private/reserved one before ever calling
// fetchImpl. For the real fetch path, the same lookup is also wired in as
// undici's `connect.lookup` on a Dispatcher passed to undici's OWN `fetch`
// (not Node's global `fetch`, which is powered by a separate, internal
// undici instance that won't reliably honor a userland-package Dispatcher),
// so the socket that ends up connecting is pinned to the exact address that
// was just validated - closing the DNS-rebinding window where a second,
// separate lookup at connect time could answer differently than the one
// used to validate.
import { promises as dns, lookup as dnsLookupCallback } from "node:dns";
import type { LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

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

/** Parse a dotted-quad string into 4 octet numbers, or null if it isn't one. */
function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

/** The private/reserved IPv4 ranges an SSRF-hardened fetcher must refuse:
 *  0/8 ("this network", not just 0.0.0.0), 10/8, 100.64/10 (CGNAT),
 *  127/8 (loopback), 169.254/16 (link-local, incl. cloud metadata),
 *  172.16/12, 192.0.2/24 + 198.51.100/24 + 203.0.113/24 (documentation
 *  TEST-NETs), 192.168/16, and 240/4 (reserved, incl. the broadcast
 *  address). Shared between the cheap hostname-literal guard below and the
 *  real IP-level check (isPrivateOrReservedIp) so the ranges never drift
 *  apart from each other. */
function isPrivateOrReservedIPv4Parts(nums: [number, number, number, number]): boolean {
  const [a, b, c] = nums;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 240) return true;
  return false;
}

function isPrivateIPv4(hostname: string): boolean {
  const parsed = parseIPv4(hostname);
  return parsed !== null && isPrivateOrReservedIPv4Parts(parsed);
}

/** ::ffff:a.b.c.d (optionally zero-padded, e.g. "0:0:0:0:0:ffff:a.b.c.d") -
 *  extracts the embedded IPv4 address so it can be re-checked against the
 *  same IPv4 ranges. */
const IPV4_MAPPED_RE = /(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** IPv6 literal checks: ::1 (loopback), :: (unspecified), fc00::/7 (unique
 *  local), fe80::/10 (link-local). All other IPv6 addresses (including the
 *  documentation range 2001:db8::/32) are left alone. */
function isPrivateOrReservedIPv6(addr: string): boolean {
  if (addr === "::1") return true;
  if (addr === "::" || addr === "0:0:0:0:0:0:0:0") return true;
  const firstHextet = (addr.split(":").find((h) => h.length > 0) ?? "").padStart(4, "0");
  if (firstHextet.startsWith("fc") || firstHextet.startsWith("fd")) return true; // fc00::/7
  if (firstHextet.startsWith("fe") && /[89ab]/.test(firstHextet[2])) return true; // fe80::/10
  return false;
}

/** IP-level SSRF guard: true for any IPv4 or IPv6 address (including an
 *  IPv4-mapped IPv6 address) that is private, loopback, link-local, CGNAT,
 *  a documentation/TEST-NET address, or otherwise reserved. This is what
 *  catches a wildcard-DNS name (e.g. "10.0.0.1.xip.io" or
 *  "169.254.169.254.xip.io") that the hostname-string guard cannot see
 *  through - those names look like ordinary public hosts until resolved. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  const v4 = parseIPv4(addr);
  if (v4) return isPrivateOrReservedIPv4Parts(v4);
  const mapped = addr.match(IPV4_MAPPED_RE);
  if (mapped) {
    const embedded = parseIPv4(mapped[1]);
    if (embedded) return isPrivateOrReservedIPv4Parts(embedded);
  }
  return isPrivateOrReservedIPv6(addr);
}

/** Shared SSRF guard: true only for an https URL whose hostname is a real,
 *  publicly routable name/address - never localhost, a private/reserved
 *  IPv4 literal, any IPv6 literal, or a .internal/.local suffixed host.
 *  Used both to filter model-suggested competitor URLs (normalizeOrigin)
 *  and as the first check inside politeFetch itself. This is a cheap,
 *  sync, string-only check - it cannot see where a hostname actually
 *  resolves, so politeFetch layers a DNS-level check (below) on top. */
export function isPubliclyRoutableHttps(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  let hostname = u.hostname.toLowerCase();
  // A single trailing dot is a no-op to DNS ("localhost." resolves exactly
  // like "localhost") but defeats naive equality/suffix checks, so strip it
  // before comparing.
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "localhost") return false;
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
  // Bracketed IPv6 literals ("[::1]", "[2001:db8::1]") - URL.hostname keeps
  // the brackets for IPv6 hosts, which is what marks it as a literal here.
  if (hostname.startsWith("[") && hostname.endsWith("]")) return false;
  if (isPrivateIPv4(hostname)) return false;
  return true;
}

/** Resolves a hostname to its address(es). Injectable so tests never touch
 *  real DNS; defaults to a real lookup for production traffic. */
export type HostResolver = (hostname: string) => Promise<string[]>;

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** Resolves `hostname` and returns a human-readable reason it must be
 *  blocked, or null when every resolved address is publicly routable. DNS
 *  failures fail closed (blocked) rather than silently proceeding. */
async function findBlockedAddressReason(hostname: string, resolve: HostResolver): Promise<string | null> {
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    return `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (addresses.length === 0) return `DNS resolution returned no addresses for ${hostname}`;
  const bad = addresses.find((ip) => isPrivateOrReservedIp(ip));
  return bad ? `blocked private/reserved address ${bad} resolved for host ${hostname}` : null;
}

/** Custom `connect.lookup` for the pinned undici dispatcher (real fetch path
 *  only): resolves via the same private/reserved check as everywhere else,
 *  refuses to connect if any address is bad, and - critically - hands
 *  undici the exact address it just validated (rather than letting undici
 *  do its own, separate lookup). Validation and connection sharing one DNS
 *  answer is what closes the rebinding window: a second lookup performed
 *  later, at connect time, could legitimately return a different address
 *  than the one that was checked. */
function pinnedLookup(
  hostname: string,
  _options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  dnsLookupCallback(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, "");
      return;
    }
    if (!addresses || addresses.length === 0) {
      callback(new Error(`DNS lookup returned no addresses for ${hostname}`), "");
      return;
    }
    const bad = addresses.find((a) => isPrivateOrReservedIp(a.address));
    if (bad) {
      callback(new Error(`blocked private/reserved address ${bad.address} resolved for host ${hostname}`), "");
      return;
    }
    const chosen = addresses[0];
    callback(null, chosen.address, chosen.family);
  });
}

let pinnedDispatcher: Agent | null = null;

/** Lazily-built singleton so every real fetch reuses one connection pool
 *  instead of opening a fresh undici Agent per request. */
function getPinnedDispatcher(): Agent {
  if (!pinnedDispatcher) {
    pinnedDispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  }
  return pinnedDispatcher;
}

export async function politeFetch(
  url: string,
  fetchImpl: typeof fetch = fetch,
  resolve?: HostResolver
): Promise<PoliteFetchResult> {
  if (!isPubliclyRoutableHttps(url)) {
    return { ok: false, error: "blocked private/loopback/internal target", reason: "blocked_host" };
  }
  // Real production calls (the default global fetch, unmodified) always
  // DNS-resolve and IP-validate the host - this is what closes the
  // wildcard-DNS-to-private-IP bypass the string guard above cannot see.
  // Tests that inject a fetchImpl but no resolver skip this step, so the
  // rest of the radar suite (which only mocks fetchImpl) stays network-free;
  // tests exercising this guard inject both a fetchImpl and a resolve stub
  // (see fetch.server.test.ts).
  const effectiveResolve = resolve ?? (fetchImpl === fetch ? defaultResolveHost : undefined);
  return fetchWithRedirects(url, fetchImpl, 0, Date.now() + REDIRECT_CHAIN_DEADLINE_MS, effectiveResolve);
}

// Hop counting stays module-private so the 3-hop cap is an enforced
// invariant, not a caller-overridable parameter. Each hop re-applies the
// full politeness set (UA, per-hop 5s timeout, size cap on the final
// response). The redirect target is already origin-pinned (see the
// cross-host check below) - same origin means same hostname, so a redirect
// can never smuggle a different host past the checks below - but the
// DNS-level check is still re-run on every hop (cheap: one extra `resolve`
// call) since a hop's own connection is what actually goes over the wire.
// `deadline` is an overall wall-clock cap threaded across every hop of one
// chain so a max-length chain can't take ~4x the per-hop timeout.
async function fetchWithRedirects(
  url: string,
  fetchImpl: typeof fetch,
  hops: number,
  deadline: number,
  resolve?: HostResolver
): Promise<PoliteFetchResult> {
  if (Date.now() >= deadline) {
    return { ok: false, error: "redirect chain exceeded the overall wall-clock cap", reason: "timeout" };
  }
  if (resolve) {
    const hostname = new URL(url).hostname;
    const blockedReason = await findBlockedAddressReason(hostname, resolve);
    if (blockedReason) {
      return { ok: false, error: blockedReason, reason: "blocked_host" };
    }
  }
  try {
    const usingRealFetch = fetchImpl === fetch;
    const requestInit = {
      headers: {
        "user-agent": RADAR_USER_AGENT,
        accept: "text/html,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "manual" as const,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    };
    // The real (non-test) path must call undici's OWN `fetch` - not Node's
    // global `fetch` - with the pinned Agent as `dispatcher`. Node's global
    // fetch is powered by its own internal, separately-instantiated copy of
    // undici; a Dispatcher built from the userland `undici` package is a
    // different module instance and is not reliably honored as a
    // `dispatcher` by the global fetch, so the pin would silently never
    // apply. Using undici's own `fetch` guarantees the Agent and the fetch
    // call share one undici instance, so `connect.lookup` (pinnedLookup)
    // genuinely governs the connection. The injected-mock path (tests)
    // still calls `fetchImpl` (the default global `fetch` reference or a
    // test's mock) unchanged.
    // Cast: undici's own `Response` type and the DOM `Response` type used by
    // the rest of this function both implement the same Fetch API surface
    // (status, ok, headers.get, body, text) - the only mismatch TS reports is
    // a newer `.bytes()` method on the DOM lib type that this function never
    // calls, so the cast is safe for everything actually used below.
    const res = usingRealFetch
      ? ((await undiciFetch(url, { ...requestInit, dispatcher: getPinnedDispatcher() })) as unknown as Response)
      : await fetchImpl(url, requestInit);

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
      return fetchWithRedirects(nextUrl, fetchImpl, hops + 1, deadline, resolve);
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
