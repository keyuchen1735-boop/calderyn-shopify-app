import { describe, it, expect } from "vitest";
import { parseRepoList, repoLabel, type Activity, type CommitInfo, type PullInfo } from "../collect.server";
import { groupByActor, renderHtml, renderText } from "../render.server";

const APP = "Mezoh/hive-mind";
const SITE = "Mezoh/amoeba-landing-page";

function commit(subject: string, login: string, repo: string): CommitInfo {
  return {
    sha: subject + repo,
    subject,
    author: login,
    login,
    branch: "main",
    isoDate: "2026-07-24T12:00:00Z",
    repo,
  };
}
function pull(number: number, title: string, login: string, repo: string): PullInfo {
  return { number, title, body: "", author: login, url: `https://github.com/${repo}/pull/${number}`, repo };
}
function activity(over: Partial<Activity> = {}): Activity {
  return {
    repo: [APP, SITE].join(", "),
    repos: [APP, SITE],
    sinceIso: "2026-07-23T14:00:00Z",
    commits: [],
    mergedPRs: [],
    openedPRs: [],
    branchesScanned: 2,
    branchesTotal: 2,
    notes: [],
    ...over,
  };
}
const input = (over = {}) => ({ dateLabel: "July 24, 2026", brand: "Amoeba", overview: "", prose: {}, ...over });

describe("parseRepoList", () => {
  it("parses a single repo", () => {
    expect(parseRepoList("owner/one")).toEqual(["owner/one"]);
  });

  it("parses a comma-separated list and trims whitespace", () => {
    expect(parseRepoList(" owner/one ,owner/two , owner/three ")).toEqual([
      "owner/one",
      "owner/two",
      "owner/three",
    ]);
  });

  it("drops duplicates while preserving configured order", () => {
    expect(parseRepoList("b/two, a/one, b/two")).toEqual(["b/two", "a/one"]);
  });

  it("returns an empty list for undefined, empty, or separator-only values", () => {
    expect(parseRepoList(undefined)).toEqual([]);
    expect(parseRepoList("")).toEqual([]);
    expect(parseRepoList(" , , ")).toEqual([]);
  });
});

describe("repoLabel", () => {
  it("reduces owner/name to the repo name", () => {
    expect(repoLabel(APP)).toBe("hive-mind");
    expect(repoLabel(SITE)).toBe("amoeba-landing-page");
  });

  it("passes through a bare name with no owner", () => {
    expect(repoLabel("solo")).toBe("solo");
  });
});

describe("multi-repo rendering", () => {
  const a = activity({
    commits: [
      commit("wire the collab session", "Mezoh", APP),
      commit("tune the scroll choreography", "Mezoh", SITE),
    ],
    mergedPRs: [pull(12, "Session presence", "Mezoh", APP)],
  });
  const groups = groupByActor(a);

  it("tags a person's per-repo commit split in HTML and text", () => {
    const html = renderHtml(a, groups, input());
    expect(html).toContain("hive-mind 1");
    expect(html).toContain("amoeba-landing-page 1");
    expect(renderText(a, groups, input())).toContain("hive-mind 1 · amoeba-landing-page 1");
  });

  it("chips each merged PR with its repo", () => {
    expect(renderHtml(a, groups, input())).toContain(">hive-mind</span>");
    expect(renderText(a, groups, input())).toContain("#12 Session presence [hive-mind]");
  });

  it("links every tracked repo in the footer, not a hardcoded one", () => {
    const html = renderHtml(a, groups, input());
    expect(html).toContain(`https://github.com/${APP}`);
    expect(html).toContain(`https://github.com/${SITE}`);
    expect(html).not.toContain("calderyn-shopify-app");
  });

  it("omits repo chips and splits for a single-repo digest", () => {
    const solo = activity({
      repo: APP,
      repos: [APP],
      commits: [commit("wire the collab session", "Mezoh", APP)],
      mergedPRs: [pull(12, "Session presence", "Mezoh", APP)],
    });
    const soloGroups = groupByActor(solo);
    const text = renderText(solo, soloGroups, input());
    expect(text).toContain("#12 Session presence");
    expect(text).not.toContain("[hive-mind]");
  });

  it("falls back to the single repo label when repos is absent", () => {
    const legacy = { ...activity({ repo: APP }), repos: undefined } as unknown as Activity;
    expect(renderText(legacy, [], input())).toContain(`https://github.com/${APP}`);
  });
});
