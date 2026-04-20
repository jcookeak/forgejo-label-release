import { describe, expect, it } from "vitest";
import { extractPrNumber, extractPrNumbers, findMergedPrs } from "../src/prs.ts";
import type { ForgejoClient } from "../src/forgejo.ts";
import type { PullRequestRef, ReleaseRef } from "../src/types.ts";

describe("extractPrNumber", () => {
  it("finds squash-merge trailer", () => {
    expect(extractPrNumber("Add feature (#42)")).toBe(42);
  });
  it("finds merge commit form", () => {
    expect(extractPrNumber("Merge pull request #99 from topic")).toBe(99);
  });
  it("returns null for plain commits", () => {
    expect(extractPrNumber("fix typo")).toBeNull();
  });
  it("prefers the squash form when both appear", () => {
    expect(extractPrNumber("Add thing (#1)\n\nMerge pull request #2")).toBe(1);
  });
});

describe("extractPrNumbers", () => {
  it("dedupes while preserving order", () => {
    expect(extractPrNumbers(["Feat (#3)", "Fix (#1)", "Feat again (#3)", "Docs"])).toEqual([3, 1]);
  });
});

describe("findMergedPrs", () => {
  it("fetches each unique PR discovered via commit-walk", async () => {
    const calls: number[] = [];
    const client: ForgejoClient = {
      listTags: async () => [],
      getLatestRelease: async (): Promise<ReleaseRef | null> => null,
      listMergedPullRequests: async () => [],
      compareCommits: async () => [
        { sha: "a", message: "Add feature (#10)" },
        { sha: "b", message: "Fix bug (#11)" },
        { sha: "c", message: "chore" },
      ],
      getPullRequest: async (n) => {
        calls.push(n);
        return {
          number: n,
          title: `PR ${n}`,
          author: "alice",
          labels: [],
          url: "",
          mergeCommitSha: "",
        } satisfies PullRequestRef;
      },
      createRelease: async () => ({ id: 0, tagName: "", targetCommitish: "" }),
    };

    const prs = await findMergedPrs(client, "v1.0.0", "HEAD");
    expect(prs.map((p) => p.number)).toEqual([10, 11]);
    expect(calls.sort()).toEqual([10, 11]);
  });
});
