import { describe, it, expect } from "vitest";
import { buildTemplateSummary } from "../summarize.server";
import type { Activity, CommitInfo, PullInfo } from "../collect.server";

function commit(subject: string, branch = "main"): CommitInfo {
  return { sha: subject, subject, author: "dev", branch, isoDate: "2026-06-11T12:00:00Z" };
}
function pull(number: number, title: string): PullInfo {
  return { number, title, body: "", author: "dev", url: `https://x/${number}` };
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

describe("buildTemplateSummary", () => {
  it("groups conventional commits into friendly buckets and strips the prefix", () => {
    const out = buildTemplateSummary(
      activity({
        commits: [
          commit("feat(ads): add ROAS column"),
          commit("fix: stop crash on null budget"),
          commit("chore: bump deps"),
        ],
      }),
      "June 11, 2026",
    );
    expect(out).toContain("New features:");
    expect(out).toContain("  - add ROAS column");
    expect(out).toContain("Bug fixes:");
    expect(out).toContain("  - stop crash on null budget");
    expect(out).toContain("Maintenance:");
    // prefix must be stripped — the raw conventional form should not survive
    expect(out).not.toContain("feat(ads): add ROAS column");
  });

  it("files non-conventional commit subjects under 'Other changes'", () => {
    const out = buildTemplateSummary(
      activity({ commits: [commit("Merge pull request #75 from x")] }),
      "June 11, 2026",
    );
    expect(out).toContain("Other changes:");
    expect(out).toContain("  - Merge pull request #75 from x");
  });

  it("renders merged and opened PRs in distinct sections", () => {
    const out = buildTemplateSummary(
      activity({ mergedPRs: [pull(70, "Recovered impact fix")], openedPRs: [pull(80, "WIP autopilot caps")] }),
      "June 11, 2026",
    );
    expect(out).toContain("Pull requests merged (1):");
    expect(out).toContain("  - #70 Recovered impact fix (@dev)");
    expect(out).toContain("Pull requests opened (1):");
    expect(out).toContain("  - #80 WIP autopilot caps (@dev)");
  });

  it("surfaces collection notes (e.g. branch-scan truncation) in the body", () => {
    const out = buildTemplateSummary(
      activity({ commits: [commit("feat: x")], notes: ["Scanned 40 of 57 branches (capped at 40); some branch commits may be omitted."] }),
      "June 11, 2026",
    );
    expect(out).toContain("Note: Scanned 40 of 57 branches");
  });
});
