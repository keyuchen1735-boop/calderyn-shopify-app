import { describe, it, expect, vi } from "vitest";
import {
  makeMetaActionAdapter,
  mergeExcludedRegions,
  dropExcludedRegions,
  type MetaTargeting,
} from "../actions.server";
import { ActionError, isRetriableFailure } from "../../ads/actions";
import { RateLimitError } from "../../ads/backoff";
import { regionStateNames } from "../../ads/geo-regions";
import type { MetaClient, MetaResponse } from "../campaigns.server";

function client(getBody: Record<string, unknown>): MetaClient {
  return {
    get: vi.fn(async () => getBody),
    post: vi.fn(async () => ({ success: true })),
  };
}

type AdSet = { id: string; targeting?: MetaTargeting };

// A path-dispatching fake MetaClient: /search resolves a region name to a key,
// /<id>/adsets lists the campaign's ad sets, POST /<adsetId> captures the merged
// targeting. Mirrors the three Graph calls excludeGeo/includeGeo make.
function geoClient(opts: {
  resolveKey?: (name: string) => string | null; // null → no matching region (resolution failure)
  adSets?: AdSet[];
}): { client: MetaClient; posts: Array<{ path: string; targeting: MetaTargeting }> } {
  const posts: Array<{ path: string; targeting: MetaTargeting }> = [];
  const client: MetaClient = {
    get: vi.fn(async (path: string, params: Record<string, string> = {}): Promise<MetaResponse> => {
      if (path === "/search") {
        const name = params.q ?? "";
        const key = opts.resolveKey ? opts.resolveKey(name) : `K:${name}`;
        return key == null
          ? { data: [] }
          : { data: [{ key, name, type: "region", country_code: "US" }] };
      }
      if (path.endsWith("/adsets")) return { data: opts.adSets ?? [] };
      return {};
    }),
    post: vi.fn(async (path: string, body: Record<string, string>): Promise<MetaResponse> => {
      posts.push({ path, targeting: JSON.parse(body.targeting) as MetaTargeting });
      return { success: true };
    }),
  };
  return { client, posts };
}

describe("metaActionAdapter", () => {
  it("pause posts status PAUSED", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).pause("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "PAUSED" });
  });

  it("resume posts status ACTIVE", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).resume("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "ACTIVE" });
  });

  it("setDailyBudget posts daily_budget in minor units as a string", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).setDailyBudget("c1", 5000);
    expect(c.post).toHaveBeenCalledWith("/c1", { daily_budget: "5000" });
  });

  it("getState maps effective_status + daily_budget", async () => {
    const c = client({ status: "PAUSED", daily_budget: "5000" });
    const s = await makeMetaActionAdapter(c).getState("c1");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });

});

describe("meta targeting merge helpers", () => {
  it("mergeExcludedRegions adds new keys and preserves existing excluded regions + sibling fields", () => {
    const t: MetaTargeting = {
      geo_locations: { countries: ["US"] },
      excluded_geo_locations: { regions: [{ key: "111" }], cities: [{ key: "c9" }] },
    };
    const merged = mergeExcludedRegions(t, ["111", "222"]);
    expect(merged.excluded_geo_locations?.regions).toEqual([{ key: "111" }, { key: "222" }]); // 111 not duplicated
    expect(merged.excluded_geo_locations?.cities).toEqual([{ key: "c9" }]); // sibling field preserved
    expect(merged.geo_locations).toEqual({ countries: ["US"] }); // included targeting untouched
  });

  it("dropExcludedRegions removes only the given keys, keeping others", () => {
    const t: MetaTargeting = { excluded_geo_locations: { regions: [{ key: "111" }, { key: "999" }] } };
    const dropped = dropExcludedRegions(t, ["111"]);
    expect(dropped.excluded_geo_locations?.regions).toEqual([{ key: "999" }]);
  });
});

describe("metaActionAdapter geo exclusion", () => {
  it("excludeGeo resolves each state to a region key and merges them into every ad set", async () => {
    const { client: c, posts } = geoClient({
      adSets: [
        { id: "as1", targeting: { geo_locations: { countries: ["US"] } } },
        {
          id: "as2",
          targeting: { geo_locations: { countries: ["US"] }, excluded_geo_locations: { regions: [{ key: "OLD" }] } },
        },
      ],
    });
    await makeMetaActionAdapter(c).excludeGeo("c1", "us-east");

    const expectedKeys = regionStateNames("us-east").map((n) => `K:${n}`); // 12 states incl. DC
    expect(posts).toHaveLength(2);
    expect(posts[0].path).toBe("/as1");
    expect(posts[0].targeting.excluded_geo_locations?.regions?.map((r) => r.key)).toEqual(expectedKeys);
    // as2 keeps its pre-existing OLD exclusion and gains the region's keys.
    expect(posts[1].targeting.excluded_geo_locations?.regions?.map((r) => r.key)).toEqual(["OLD", ...expectedKeys]);
  });

  it("excludeGeo does not re-POST an ad set already fully excluding the region", async () => {
    const fullyExcluded = regionStateNames("us-west").map((n) => ({ key: `K:${n}` }));
    const { client: c, posts } = geoClient({
      adSets: [{ id: "as1", targeting: { excluded_geo_locations: { regions: fullyExcluded } } }],
    });
    await makeMetaActionAdapter(c).excludeGeo("c1", "us-west");
    expect(posts).toHaveLength(0); // nothing changed → no write
  });

  it("includeGeo removes only the region's keys from each ad set, preserving others", async () => {
    const westKeys = regionStateNames("us-west").map((n) => ({ key: `K:${n}` }));
    const { client: c, posts } = geoClient({
      adSets: [{ id: "as1", targeting: { excluded_geo_locations: { regions: [{ key: "OTHER" }, ...westKeys] } } }],
    });
    await makeMetaActionAdapter(c).includeGeo("c1", "us-west");
    expect(posts).toHaveLength(1);
    expect(posts[0].targeting.excluded_geo_locations?.regions).toEqual([{ key: "OTHER" }]);
  });

  it("excludeGeo fails visibly (no phantom) when a state's region key can't be resolved", async () => {
    const { client: c, posts } = geoClient({
      resolveKey: () => null, // Meta returns no matching region
      adSets: [{ id: "as1", targeting: {} }],
    });
    const err = await makeMetaActionAdapter(c).excludeGeo("c1", "us-west").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(isRetriableFailure(err)).toBe(false);
    expect(posts).toHaveLength(0); // resolution fails before any write
  });

  it("excludeGeo fails visibly when the campaign has no ad sets to exclude", async () => {
    const { client: c } = geoClient({ adSets: [] });
    const err = await makeMetaActionAdapter(c).excludeGeo("c1", "us-west").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(isRetriableFailure(err)).toBe(false);
  });
});

describe("metaActionAdapter rate limiting", () => {
  const THROTTLED = { error: { message: "There have been too many calls to this ad-account.", code: 80004 } };
  const NO_SLEEP = { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} };

  it("retries a throttled setDailyBudget with backoff and succeeds", async () => {
    let calls = 0;
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => (++calls === 1 ? THROTTLED : { success: true })),
    };
    await makeMetaActionAdapter(c, NO_SLEEP).setDailyBudget("c1", 700);
    expect(c.post).toHaveBeenCalledTimes(2);
  });

  it("a still-throttled call exhausts the cap and stays classified retriable for the executor", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => THROTTLED),
    };
    const err = await makeMetaActionAdapter(c, NO_SLEEP)
      .setDailyBudget("c1", 700)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(isRetriableFailure(err)).toBe(true);
    expect(c.post).toHaveBeenCalledTimes(NO_SLEEP.maxAttempts);
  });

  it("non-throttle errors fail fast without retrying", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => ({ error: { message: "Invalid parameter", code: 100 } })),
    };
    await expect(makeMetaActionAdapter(c, NO_SLEEP).setDailyBudget("c1", 700)).rejects.toThrow(
      /Invalid parameter/,
    );
    expect(c.post).toHaveBeenCalledTimes(1);
  });

  it("pause retries a throttled status post", async () => {
    let calls = 0;
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => (++calls === 1 ? THROTTLED : { success: true })),
    };
    await makeMetaActionAdapter(c, NO_SLEEP).pause("c1");
    expect(c.post).toHaveBeenCalledTimes(2);
    expect(c.post).toHaveBeenLastCalledWith("/c1", { status: "PAUSED" });
  });

  it("getState retries a throttled read", async () => {
    let calls = 0;
    const c: MetaClient = {
      get: vi.fn(async () => (++calls === 1 ? THROTTLED : { status: "PAUSED", daily_budget: "500" })),
      post: vi.fn(async () => ({ success: true })),
    };
    const s = await makeMetaActionAdapter(c, NO_SLEEP).getState("c1");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 500 });
    expect(c.get).toHaveBeenCalledTimes(2);
  });
});

// A permanent Graph error (object deleted on Meta's side, dead token, missing
// permission) must fail TERMINALLY, not park as `retrying`. Misclassifying it
// retriable both burns the action-retry budget against an action that can never
// succeed AND (because the dashboard route returns HTTP 200 for `retrying`) lets
// the UI report a false success. Regression guard for P0-1.
describe("metaActionAdapter permanent-error classification", () => {
  const NO_SLEEP = { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} };
  const errResponse = (message: string, code: number) => ({ error: { message, code } });
  const grab = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it("pause classifies 'object does not exist' (code 100) as a terminal, non-retriable failure", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () =>
        errResponse("Unsupported post request. Object with ID '120247426477610026' does not exist", 100),
      ),
    };
    const err = await grab(makeMetaActionAdapter(c, NO_SLEEP).pause("c1"));
    expect(err).toBeInstanceOf(ActionError);
    expect(isRetriableFailure(err)).toBe(false);
    expect(c.post).toHaveBeenCalledTimes(1); // no retry of a permanent error
  });

  it("resume classifies an expired token (code 190) as non-retriable", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => errResponse("Error validating access token", 190)),
    };
    const err = await grab(makeMetaActionAdapter(c, NO_SLEEP).resume("c1"));
    expect(err).toBeInstanceOf(ActionError);
    expect(isRetriableFailure(err)).toBe(false);
  });

  it("setDailyBudget classifies a permissions error (code 200) as non-retriable", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => errResponse("Permissions error", 200)),
    };
    const err = await grab(makeMetaActionAdapter(c, NO_SLEEP).setDailyBudget("c1", 700));
    expect(err).toBeInstanceOf(ActionError);
    expect(isRetriableFailure(err)).toBe(false);
  });

  it("keeps an unknown/transient Graph error retriable (a blip must not lose the recovery)", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => errResponse("Temporary internal error", 2)),
    };
    const err = await grab(makeMetaActionAdapter(c, NO_SLEEP).pause("c1"));
    expect(err).toBeInstanceOf(ActionError);
    expect(isRetriableFailure(err)).toBe(true);
  });
});
