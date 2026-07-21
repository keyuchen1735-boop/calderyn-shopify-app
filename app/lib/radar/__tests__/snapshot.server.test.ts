import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCompetitors: vi.fn(),
  latestSnapshots: vi.fn(),
  insertSnapshot: vi.fn(),
  loadRobots: vi.fn(),
  politeFetch: vi.fn(),
}));
vi.mock("../competitor-store.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCompetitors: mocks.listCompetitors,
  latestSnapshots: mocks.latestSnapshots,
  insertSnapshot: mocks.insertSnapshot,
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
});
