import { describe, expect, it } from "vitest";
import { parseTemplate, renderNotes } from "../src/release-notes.ts";
import type { PullRequestRef } from "../src/types.ts";

function pr(n: number, title: string, labels: string[], author = "alice"): PullRequestRef {
  return { number: n, title, labels, author, url: "", mergeCommitSha: "" };
}

describe("parseTemplate", () => {
  it("parses GitHub-style changelog config", () => {
    const yaml = `
changelog:
  exclude:
    labels: ["ignore"]
    authors: ["dependabot"]
  categories:
    - title: Features
      labels: ["feature", "enhancement"]
    - title: Other
      labels: ["*"]
`;
    const tpl = parseTemplate(yaml);
    expect(tpl.categories).toHaveLength(2);
    expect(tpl.categories[0]?.title).toBe("Features");
    expect(tpl.exclude?.labels).toContain("ignore");
  });

  it("returns empty categories when no changelog key present", () => {
    expect(parseTemplate("name: foo").categories).toEqual([]);
  });
});

describe("renderNotes", () => {
  const tpl = parseTemplate(`
changelog:
  exclude:
    labels: ["skip-changelog"]
  categories:
    - title: Breaking
      labels: ["breaking"]
    - title: Features
      labels: ["feature"]
    - title: Bug Fixes
      labels: ["bug"]
`);

  it("groups PRs by category and excludes 'skip-changelog'", () => {
    const prs = [
      pr(1, "Redesign auth", ["breaking"]),
      pr(2, "New endpoint", ["feature"]),
      pr(3, "Silent chore", ["skip-changelog"]),
      pr(4, "Untagged", []),
    ];
    const out = renderNotes(prs, tpl, { previousTag: "v1.0.0", newTag: "v2.0.0" });
    expect(out).toContain("### Breaking");
    expect(out).toContain("### Features");
    expect(out).toContain("### Other Changes");
    expect(out).toContain("#1");
    expect(out).toContain("#2");
    expect(out).toContain("#4");
    expect(out).not.toContain("#3");
  });

  it("does not add 'Other Changes' when a wildcard category exists", () => {
    const wildTpl = parseTemplate(`
changelog:
  categories:
    - title: Everything
      labels: ["*"]
`);
    const out = renderNotes([pr(1, "x", ["random"])], wildTpl, {
      previousTag: null,
      newTag: "v0.1.0",
    });
    expect(out).toContain("### Everything");
    expect(out).not.toContain("Other Changes");
  });

  it("falls back to a flat list when no template", () => {
    const out = renderNotes([pr(1, "x", ["bug"])], null, {
      previousTag: null,
      newTag: "v0.0.1",
    });
    expect(out).toMatch(/^\* x by @alice in #1/);
  });

  it("appends full-changelog link when previousTag + compareUrl provided", () => {
    const out = renderNotes([pr(1, "x", ["bug"])], null, {
      previousTag: "v1.0.0",
      newTag: "v1.0.1",
      compareUrl: "https://fj.example/owner/repo/compare/v1.0.0...v1.0.1",
    });
    expect(out).toContain(
      "**Full Changelog**: https://fj.example/owner/repo/compare/v1.0.0...v1.0.1",
    );
  });
});
