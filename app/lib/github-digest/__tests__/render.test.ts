import { describe, it, expect } from "vitest";
import { classifyActor, groupByActor, renderHtml, renderText, renderEmptyHtml } from "../render.server";
import type { Activity, CommitInfo, PullInfo } from "../collect.server";

function commit(subject: string, login: string, name = login): CommitInfo {
  return { sha: subject + login, subject, author: name, login, branch: "main", isoDate: "2026-06-11T12:00:00Z" };
}
function pull(number: number, title: string, login: string): PullInfo {
  return { number, title, body: "", author: login, url: `https://github.com/x/pull/${number}` };
}
function activity(over: Partial<Activity>): Activity {
  return {
    repo: "owner/repo",
    sinceIso: "2026-06-10T14:00:00Z",
    commits: [],
    mergedPRs: [],
    openedPRs: [],
    branchesScanned: 1,
    branchesTotal: 1,
    notes: [],
    ...over,
  };
}
const input = (over = {}) => ({ dateLabel: "June 11, 2026", brand: "Calderyn", overview: "", prose: {}, ...over });

describe("classifyActor", () => {
  it("maps keyuchen / eric to Eric (teal)", () => {
    expect(classifyActor({ login: "keyuchen1735-boop" })).toMatchObject({ key: "eric", label: "Eric", color: "#24556E" });
    expect(classifyActor({ name: "Eric Chen" }).key).toBe("eric");
  });
  it("maps mezoh / john / duncan to John (terracotta)", () => {
    expect(classifyActor({ login: "mezohyt-3164" })).toMatchObject({ key: "john", label: "John", color: "#c96442" });
    expect(classifyActor({ name: "John Duncan" }).key).toBe("john");
  });
  it("falls back to a neutral actor for anyone else", () => {
    const a = classifyActor({ login: "web-flow", name: "GitHub" });
    expect(a.key).toBe("web-flow");
    expect(a.color).toBe("#6E6E73");
  });
});

describe("groupByActor", () => {
  it("groups commits and PRs by person, Eric before John before others", () => {
    const groups = groupByActor(
      activity({
        commits: [commit("fix a", "keyuchen1735-boop"), commit("feat b", "mezohyt-3164"), commit("c", "web-flow")],
        mergedPRs: [pull(70, "Eric PR", "keyuchen1735-boop"), pull(75, "John PR", "mezohyt-3164")],
      }),
    );
    expect(groups.map((g) => g.actor.key)).toEqual(["eric", "john", "web-flow"]);
    expect(groups[0].commits).toHaveLength(1);
    expect(groups[0].mergedPRs[0].number).toBe(70);
    expect(groups[1].mergedPRs[0].number).toBe(75);
  });
});

describe("renderHtml", () => {
  const groups = groupByActor(
    activity({
      commits: [commit("fix budget", "keyuchen1735-boop"), commit("feat ads", "mezohyt-3164")],
      mergedPRs: [pull(70, "Recovered impact fix", "keyuchen1735-boop")],
    }),
  );

  it("includes the Calderyn brand, both people, and the merged PR", () => {
    const html = renderHtml(activity({}), groups, input({ overview: "Busy day.", prose: { eric: "Fixed budgets." } }));
    expect(html).toContain("Calderyn");
    expect(html).toContain("#24556E"); // brand accent
    expect(html).toContain("#1a1a2e"); // logo badge navy
    expect(html).toContain("#7ee0c3"); // logo mark mint "C"
    expect(html).toContain("Eric");
    expect(html).toContain("John");
    expect(html).toContain("Recovered impact fix");
    expect(html).toContain("Busy day.");
    expect(html).toContain("Fixed budgets.");
  });

  it("escapes HTML in PR titles to prevent injection", () => {
    const g = groupByActor(activity({ mergedPRs: [pull(9, "<script>alert(1)</script>", "keyuchen1735-boop")] }));
    const html = renderHtml(activity({}), g, input());
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a custom brand's name and initial instead of Calderyn", () => {
    const html = renderHtml(activity({}), groups, input({ brand: "Amoeba" }));
    expect(html).toContain("Amoeba");
    expect(html).not.toContain("Calderyn");
    expect(html).toContain(">A</div>"); // logo badge initial
  });

  it("points the footer link at the digest's own repo, not a hardcoded Calderyn one", () => {
    const html = renderHtml(activity({}), groups, input({ brand: "Amoeba", repo: "Mezoh/hive-mind" }));
    expect(html).toContain("https://github.com/Mezoh/hive-mind");
    expect(html).toContain(">hive-mind</a>");
    expect(html).not.toContain("calderyn-shopify-app");
  });

  it("defaults the footer link to the Calderyn repo when no repo is given", () => {
    const html = renderHtml(activity({}), groups, input());
    expect(html).toContain("https://github.com/keyuchen1735-boop/calderyn-shopify-app");
  });
});

describe("renderText", () => {
  it("renders an attributed plaintext twin with overview and merged PRs", () => {
    const groups = groupByActor(
      activity({ commits: [commit("x", "mezohyt-3164")], mergedPRs: [pull(75, "John work", "mezohyt-3164")] }),
    );
    const text = renderText(activity({}), groups, input({ overview: "Summary line." }));
    expect(text).toContain("Daily dev digest");
    expect(text).toContain("Summary line.");
    expect(text).toContain("John");
    expect(text).toContain("merged #75 John work");
  });
});

describe("renderEmptyHtml", () => {
  it("renders the given brand's name and initial in the quiet-day card", () => {
    const html = renderEmptyHtml("June 11, 2026", "Amoeba");
    expect(html).toContain("Amoeba");
    expect(html).not.toContain("Calderyn");
  });
});
