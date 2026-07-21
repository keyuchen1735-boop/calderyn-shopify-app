import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCompetitors: vi.fn(),
  latestSnapshots: vi.fn(),
  insertSnapshot: vi.fn(),
  touchCompetitorSnapshot: vi.fn(),
  loadRobots: vi.fn(),
  politeFetch: vi.fn(),
}));
vi.mock("../competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCompetitors: mocks.listCompetitors,
  latestSnapshots: mocks.latestSnapshots,
  insertSnapshot: mocks.insertSnapshot,
  touchCompetitorSnapshot: mocks.touchCompetitorSnapshot,
}));
vi.mock("../fetch.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadRobots: mocks.loadRobots,
  politeFetch: mocks.politeFetch,
}));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import {
  contentHash,
  diffExtracts,
  discoverPageUrls,
  extractFacts,
  MAX_PAGES_PER_COMPETITOR,
  normalizeText,
  SNAPSHOT_FETCH_BUDGET,
  snapshotWatchingCompetitors,
} from "../snapshot.server";

const SHOP = "11111111-1111-4111-8111-111111111111";
const COMP = {
  id: "22222222-2222-4222-8222-222222222222",
  shopId: SHOP,
  url: "https://rival.example/",
  name: "Rival",
  status: "watching" as const,
  discoveryEvidence: {},
  createdAt: "",
  updatedAt: "",
};

const HOME = `<html><head><title>Rival Gear</title>
<meta name="description" content="Boots and packs"></head>
<body><script>evil()</script><h1>Built for the trail</h1>
<a href="/products/boots">Boots $129.00</a>
<a href="/collections/packs">Packs</a>
<a href="https://elsewhere.example/x">off-site</a>
<a href="/cart">Cart</a></body></html>`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCompetitors.mockResolvedValue([COMP]);
  mocks.latestSnapshots.mockResolvedValue(new Map());
  mocks.insertSnapshot.mockResolvedValue(undefined);
  mocks.touchCompetitorSnapshot.mockResolvedValue(undefined);
  mocks.loadRobots.mockResolvedValue({ disallow: [], unreachable: false });
  mocks.politeFetch.mockResolvedValue({ ok: true, status: 200, text: HOME });
});

describe("normalizeText / contentHash", () => {
  it("is stable across whitespace and strips script/style", () => {
    const a = normalizeText("<p>Hello   <b>world</b></p><script>x()</script>");
    const b = normalizeText("<p>Hello world</p>");
    expect(a).toBe(b);
    expect(a).not.toContain("x()");
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("strips HTML comments before tag-eating, even when a comment body contains '>'", () => {
    const out = normalizeText("<p>Before</p><!-- old price > $50 --><p>After</p>");
    expect(out).toBe("Before After");
    expect(out).not.toContain("$50");
    expect(out).not.toContain("-->");
  });
});

describe("extractFacts", () => {
  it("pulls title, meta description, headings and prices deterministically", () => {
    const facts = extractFacts(HOME);
    expect(facts.title).toBe("Rival Gear");
    expect(facts.metaDescription).toBe("Boots and packs");
    expect(facts.headings).toContain("Built for the trail");
    expect(facts.prices).toContain("$129.00");
  });
  it("bounds every list", () => {
    const many = `<html><body>${Array.from({ length: 60 }, (_, i) => `<h2>H${i}</h2><span>$${i}.99</span>`).join("")}</body></html>`;
    const facts = extractFacts(many);
    expect(facts.headings.length).toBeLessThanOrEqual(20);
    expect(facts.prices.length).toBeLessThanOrEqual(20);
  });
  it("reads meta description with content before name", () => {
    const facts = extractFacts(`<html><head><meta name="description" content="Boots and packs"></head></html>`);
    expect(facts.metaDescription).toBe("Boots and packs");
  });
  it("reads meta description with name before content (either attribute order)", () => {
    const facts = extractFacts(`<html><head><meta content="Boots and packs" name="description"></head></html>`);
    expect(facts.metaDescription).toBe("Boots and packs");
  });
  it("labels a price with the nearest preceding h1-h3 heading", () => {
    const html = `<html><body><h2>Trail Boots</h2><p>Great for hiking. $129.00 today.</p></body></html>`;
    const facts = extractFacts(html);
    expect(facts.labeledPrices).toContainEqual({ label: "Trail Boots", price: "$129.00" });
  });
});

describe("price extraction (locale formats)", () => {
  it("captures complete money tokens in US convention", () => {
    const facts = extractFacts(`<html><body><h1>Shop</h1><span>$1,299.00</span></body></html>`);
    expect(facts.prices).toContain("$1,299.00");
  });
  it("captures complete money tokens in European convention", () => {
    const facts = extractFacts(`<html><body><h1>Shop</h1><span>&euro;1.299,00</span></body></html>`.replace("&euro;", "€"));
    expect(facts.prices).toContain("€1.299,00");
  });
  it("captures a plain integer price with no decimal", () => {
    const facts = extractFacts(`<html><body><h1>Shop</h1><span>£999</span></body></html>`);
    expect(facts.prices).toContain("£999");
  });
  it("captures a simple two-decimal price", () => {
    const facts = extractFacts(`<html><body><h1>Shop</h1><span>$29.99</span></body></html>`);
    expect(facts.prices).toContain("$29.99");
  });
  it("regression: does not truncate a European price mid-token", () => {
    const facts = extractFacts(`<html><body><h1>Shop</h1><span>€1.299,00</span></body></html>`);
    expect(facts.prices).not.toContain("€1.29");
    expect(facts.prices).toContain("€1.299,00");
  });
});

describe("discoverPageUrls", () => {
  it("keeps same-host product/collection links, home first, capped at 10", () => {
    const urls = discoverPageUrls(HOME, "https://rival.example");
    expect(urls[0]).toBe("https://rival.example/");
    expect(urls).toContain("https://rival.example/products/boots");
    expect(urls).toContain("https://rival.example/collections/packs");
    expect(urls.every((u) => u.startsWith("https://rival.example/"))).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(MAX_PAGES_PER_COMPETITOR);
    expect(MAX_PAGES_PER_COMPETITOR).toBe(10);
  });
  it("excludes an http:// same-host link (downgrade) but keeps an https:// same-origin link", () => {
    const html = `<html><body>
      <a href="http://rival.example/products/downgraded">HTTP boots</a>
      <a href="https://rival.example/products/secure">HTTPS boots</a>
    </body></html>`;
    const urls = discoverPageUrls(html, "https://rival.example");
    expect(urls).not.toContain("http://rival.example/products/downgraded");
    expect(urls).toContain("https://rival.example/products/secure");
  });
});

describe("diffExtracts", () => {
  const base = { title: "Rival Gear", metaDescription: "d", headings: ["Built for the trail"], prices: ["$129.00"] };
  it("returns null when nothing changed", () => {
    expect(diffExtracts(base, { ...base })).toBeNull();
  });
  it("reports title, heading and price deltas", () => {
    const next = { title: "Rival Gear - Summer Sale", metaDescription: "d", headings: ["Summer sale"], prices: ["$99.00"] };
    const diff = diffExtracts(base, next);
    expect(diff).toMatchObject({
      titleChanged: { from: "Rival Gear", to: "Rival Gear - Summer Sale" },
      newHeadings: ["Summer sale"],
      removedHeadings: ["Built for the trail"],
      newPrices: ["$99.00"],
      removedPrices: ["$129.00"],
    });
  });
  it("pairs a same-label price change into priceChanges", () => {
    const prev = { ...base, labeledPrices: [{ label: "Trail Boots", price: "$129.00" }] };
    const next = { ...base, prices: ["$99.00"], labeledPrices: [{ label: "Trail Boots", price: "$99.00" }] };
    const diff = diffExtracts(prev, next);
    expect(diff?.priceChanges).toEqual([{ label: "Trail Boots", from: "$129.00", to: "$99.00" }]);
  });
  it("does not cross-pair unrelated simultaneous price changes on different labels", () => {
    const prev = { ...base, labeledPrices: [{ label: "A", price: "$129.00" }, { label: "B", price: "$89.00" }] };
    const next = {
      ...base,
      prices: ["$99.00", "$134.00"],
      labeledPrices: [{ label: "A", price: "$99.00" }, { label: "B", price: "$134.00" }],
    };
    const diff = diffExtracts(prev, next);
    expect(diff?.priceChanges).toEqual(expect.arrayContaining([
      { label: "A", from: "$129.00", to: "$99.00" },
      { label: "B", from: "$89.00", to: "$134.00" },
    ]));
    expect(diff?.priceChanges).toHaveLength(2);
    expect(diff?.priceChanges).not.toContainEqual({ label: "A", from: "$129.00", to: "$134.00" });
    expect(diff?.priceChanges).not.toContainEqual({ label: "B", from: "$89.00", to: "$99.00" });
  });
  it("omits priceChanges when labeledPrices is missing on either side", () => {
    const next = { ...base, prices: ["$99.00"] };
    const diff = diffExtracts(base, next);
    expect(diff?.priceChanges).toBeUndefined();
  });
});

describe("snapshotWatchingCompetitors", () => {
  const deadline = () => Date.now() + 60_000;
  it("writes baselines (diff null) for first-seen pages", async () => {
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(out.pagesStored).toBeGreaterThan(0);
    for (const call of mocks.insertSnapshot.mock.calls) {
      expect(call[1].diff).toBeNull();
    }
  });
  it("skips unchanged pages entirely (hash gate) and diffs changed ones", async () => {
    const homeNorm = normalizeText(HOME);
    mocks.latestSnapshots.mockResolvedValue(new Map([
      ["https://rival.example/", { contentHash: contentHash(homeNorm), extracted: extractFacts(HOME) }],
    ]));
    // Non-home pages return changed content
    mocks.politeFetch.mockImplementation(async (url: string) =>
      url === "https://rival.example/" || url.endsWith("robots.txt")
        ? { ok: true, status: 200, text: HOME }
        : { ok: true, status: 200, text: "<html><title>New</title><h1>Fresh</h1></html>" });
    await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    const urls = mocks.insertSnapshot.mock.calls.map((c) => c[1].url);
    expect(urls).not.toContain("https://rival.example/"); // unchanged: zero rows
  });
  it("respects robots disallow for individual paths", async () => {
    mocks.loadRobots.mockResolvedValue({ disallow: ["/products"], unreachable: false });
    await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    const fetched = mocks.politeFetch.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes("/products/"))).toBe(false);
  });
  it("skips the whole host when robots is unreachable and isolates competitor failures", async () => {
    mocks.loadRobots.mockResolvedValue({ disallow: [], unreachable: true });
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(out.pagesFetched).toBe(0);
    mocks.loadRobots.mockRejectedValue(new Error("boom"));
    await expect(snapshotWatchingCompetitors(SHOP, { deadline: deadline() })).resolves.toBeTruthy();
  });
  it("stops at the deadline without throwing", async () => {
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: Date.now() - 1 });
    expect(out.pagesFetched).toBe(0);
  });
  it("rotates every attempted competitor to the back of the stalest-first queue", async () => {
    const three = [1, 2].map((n) => ({ ...COMP, id: `2222222${n}-2222-4222-8222-22222222222${n}`, url: `https://rival${n}.example/` }));
    mocks.listCompetitors.mockResolvedValue(three);
    await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(mocks.touchCompetitorSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.touchCompetitorSnapshot).toHaveBeenCalledWith(SHOP, three[0].id);
    expect(mocks.touchCompetitorSnapshot).toHaveBeenCalledWith(SHOP, three[1].id);
  });
  it("rotates a competitor even when its snapshot fails, and a rotation failure never breaks the run", async () => {
    mocks.loadRobots.mockRejectedValueOnce(new Error("boom")); // competitor snapshot throws
    mocks.touchCompetitorSnapshot.mockRejectedValueOnce(new Error("db down")); // rotation also throws
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(out).toBeTruthy();
    expect(mocks.touchCompetitorSnapshot).toHaveBeenCalledWith(SHOP, COMP.id);
  });
  it("stops early once the per-shop fetch budget is exhausted mid-run", async () => {
    // 3 competitors x MAX_PAGES_PER_COMPETITOR pages each would need 30 page
    // fetches alone (before counting the 3 robots.txt loads), which exceeds
    // SNAPSHOT_FETCH_BUDGET (30) - the run must stop partway through.
    const HOME_MANY = `<html><head><title>Rival</title></head><body>${Array.from(
      { length: 9 },
      (_, i) => `<a href="/products/p${i}">Item ${i}</a>`,
    ).join("")}</body></html>`;
    const manyCompetitors = [1, 2, 3].map((n) => ({
      ...COMP,
      id: `comp-${n}`,
      url: `https://rival${n}.example/`,
    }));
    mocks.listCompetitors.mockResolvedValue(manyCompetitors);
    mocks.politeFetch.mockImplementation(async (url: string) =>
      /^https:\/\/rival\d\.example\/$/.test(url)
        ? { ok: true, status: 200, text: HOME_MANY }
        : { ok: true, status: 200, text: "<html><title>Changed</title></html>" });
    const out = await snapshotWatchingCompetitors(SHOP, { deadline: deadline() });
    expect(out.pagesFetched).toBeLessThanOrEqual(SNAPSHOT_FETCH_BUDGET);
    expect(out.pagesFetched).toBeLessThan(manyCompetitors.length * MAX_PAGES_PER_COMPETITOR);
    expect(mocks.politeFetch.mock.calls.length).toBe(out.pagesFetched);
  });
});
