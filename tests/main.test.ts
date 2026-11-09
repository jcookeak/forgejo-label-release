import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/main.ts";
import type { Runtime } from "../src/runtime.ts";
import { ForgejoApiError, type ForgejoClient, type CreateReleaseInput } from "../src/forgejo.ts";
import type { PullRequestRef, ReleaseRef } from "../src/types.ts";

class FakeRuntime implements Runtime {
  inputs: Record<string, string> = {};
  env: Record<string, string> = {};
  files: Record<string, string> = {};
  outputs: Record<string, string> = {};
  logs: string[] = [];

  getInput(name: string): string | undefined {
    const v = this.inputs[name];
    return v === undefined || v === "" ? undefined : v;
  }
  getEnv(name: string): string | undefined {
    const v = this.env[name];
    return v === undefined || v === "" ? undefined : v;
  }
  setOutput(name: string, value: string): void {
    this.outputs[name] = value;
  }
  info(m: string): void {
    this.logs.push(m);
  }
  warn(m: string): void {
    this.logs.push(`WARN: ${m}`);
  }
  error(m: string): void {
    this.logs.push(`ERROR: ${m}`);
  }
  readFile(p: string): string | undefined {
    return this.files[p];
  }
}

interface FakeOptions {
  latestRelease?: ReleaseRef | null;
  tags?: string[];
  compareCommits?: { sha: string; message: string }[];
  compareError?: Error;
  prs?: Record<number, PullRequestRef>;
  mergedPulls?: PullRequestRef[];
}

function fakeClient(opts: FakeOptions): { client: ForgejoClient; created: CreateReleaseInput[] } {
  const created: CreateReleaseInput[] = [];
  const client: ForgejoClient = {
    listTags: async () => opts.tags ?? [],
    getLatestRelease: async () => opts.latestRelease ?? null,
    listMergedPullRequests: async () => opts.mergedPulls ?? [],
    compareCommits: async () => {
      if (opts.compareError) throw opts.compareError;
      return opts.compareCommits ?? [];
    },
    getPullRequest: async (n) => {
      const pr = opts.prs?.[n];
      if (!pr) throw new Error(`no fake PR for ${n}`);
      return pr;
    },
    createRelease: async (input) => {
      created.push(input);
      return { id: 1, tagName: input.tagName, targetCommitish: input.targetCommitish };
    },
  };
  return { client, created };
}

function baseRuntime(): FakeRuntime {
  const rt = new FakeRuntime();
  rt.inputs["major-labels"] = "breaking";
  rt.inputs["minor-labels"] = "feature";
  rt.inputs["patch-labels"] = "bug";
  rt.env["GITHUB_TOKEN"] = "t";
  rt.env["GITHUB_SERVER_URL"] = "https://fj.example";
  rt.env["GITHUB_REPOSITORY"] = "acme/widgets";
  rt.env["GITHUB_SHA"] = "headsha";
  return rt;
}

describe("run()", () => {
  let rt: FakeRuntime;
  beforeEach(() => {
    rt = baseRuntime();
  });

  it("skips the release when no labels match", async () => {
    const { client, created } = fakeClient({
      latestRelease: { id: 1, tagName: "v1.0.0", targetCommitish: "old" },
      compareCommits: [{ sha: "a", message: "chore (#1)" }],
      prs: {
        1: {
          number: 1,
          title: "chore",
          author: "a",
          labels: ["chore"],
          url: "",
          mergeCommitSha: "",
        },
      },
    });
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(0);
    expect(rt.outputs["released"]).toBe("false");
    expect(rt.outputs["bump"]).toBe("none");
  });

  it("cuts a minor release from v1.2.3 when a feature PR is present", async () => {
    const { client, created } = fakeClient({
      latestRelease: { id: 1, tagName: "v1.2.3", targetCommitish: "old" },
      compareCommits: [
        { sha: "a", message: "Add endpoint (#10)" },
        { sha: "b", message: "Fix typo (#11)" },
      ],
      prs: {
        10: {
          number: 10,
          title: "Add endpoint",
          author: "alice",
          labels: ["feature"],
          url: "",
          mergeCommitSha: "",
        },
        11: {
          number: 11,
          title: "Fix typo",
          author: "bob",
          labels: ["bug"],
          url: "",
          mergeCommitSha: "",
        },
      },
    });
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(1);
    expect(created[0]?.tagName).toBe("v1.3.0");
    expect(rt.outputs["released"]).toBe("true");
    expect(rt.outputs["bump"]).toBe("minor");
    expect(rt.outputs["previous-tag"]).toBe("v1.2.3");
  });

  it("dry-run does not call createRelease", async () => {
    rt.inputs["dry-run"] = "true";
    const { client, created } = fakeClient({
      latestRelease: { id: 1, tagName: "v0.1.0", targetCommitish: "old" },
      compareCommits: [{ sha: "a", message: "bug (#1)" }],
      prs: {
        1: { number: 1, title: "bug", author: "a", labels: ["bug"], url: "", mergeCommitSha: "" },
      },
    });
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(0);
    expect(rt.outputs["tag"]).toBe("v0.1.1");
    expect(rt.outputs["released"]).toBe("false");
  });

  it("falls back to merged PRs since the previous release target when compare is hidden", async () => {
    const { client, created } = fakeClient({
      latestRelease: { id: 1, tagName: "v1.2.3", targetCommitish: "previous-release-sha" },
      compareError: new ForgejoApiError(
        "compare commits",
        404,
        "Not Found",
        `{"message":"Can't read pulls or can't read UnitTypeCode"}`,
      ),
      mergedPulls: [
        {
          number: 12,
          title: "Fix regression",
          author: "alice",
          labels: ["bug"],
          url: "",
          mergeCommitSha: "new-sha",
        },
        {
          number: 11,
          title: "Previous release",
          author: "bob",
          labels: ["feature"],
          url: "",
          mergeCommitSha: "previous-release-sha",
        },
        {
          number: 10,
          title: "Older change",
          author: "chris",
          labels: ["breaking"],
          url: "",
          mergeCommitSha: "older-sha",
        },
      ],
    });

    await run(rt, { clientFactory: () => client });

    expect(created).toHaveLength(1);
    expect(created[0]?.tagName).toBe("v1.2.4");
    expect(rt.outputs["bump"]).toBe("patch");
    expect(rt.outputs["notes"]).toContain("Fix regression");
    expect(rt.outputs["notes"]).not.toContain("Older change");
  });
});

describe("explicit release planning", () => {
  const pr: PullRequestRef = {
    number: 4,
    title: "Repair",
    author: "alice",
    labels: ["bug"],
    url: "",
    mergeCommitSha: "headsha",
  };
  it.each([
    ["v1.4.2", "bug", "v1.4.3"],
    ["v1.4.2", "breaking", "v2.0.0"],
    ["none", "breaking", "v1.0.0"],
  ])("plans from %s", async (base, label, expected) => {
    const rt = baseRuntime();
    rt.inputs["dry-run"] = "true";
    rt.inputs["baseline-tag"] = base;
    rt.inputs["pull-request-numbers"] = "4";
    const { client, created } = fakeClient({
      latestRelease: { id: 99, tagName: "v9.0.0", targetCommitish: "unrelated" },
      prs: { 4: { ...pr, labels: [label] } },
    });
    client.getLatestRelease = async () => {
      throw new Error("must not discover global latest");
    };
    client.listMergedPullRequests = async () => {
      throw new Error("must not scan other lines");
    };
    client.compareCommits = async () => {
      throw new Error("selected PRs require no comparison");
    };
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(0);
    expect(rt.outputs["tag"]).toBe(expected);
    expect(rt.outputs["previous-tag"]).toBe(base === "none" ? "" : base);
    expect(rt.outputs["notes"]).toContain("Repair");
    expect(rt.outputs["released"]).toBe("false");
  });
  it.each([
    { "baseline-tag": "invalid", "pull-request-numbers": "4" },
    { "baseline-tag": "v2.0.0-next.9", "pull-request-numbers": "4" },
    { "pull-request-numbers": "4" },
    { "baseline-tag": "v1.2.3", "pull-request-numbers": "4,4" },
    { "baseline-tag": "v1.2.3", "pull-request-numbers": "-4" },
  ])("rejects invalid explicit inputs %j", async (inputs) => {
    const rt = baseRuntime();
    Object.assign(rt.inputs, inputs);
    rt.inputs["dry-run"] = "true";
    const { client, created } = fakeClient({ prs: { 4: pr } });
    await expect(run(rt, { clientFactory: () => client })).rejects.toThrow();
    expect(created).toHaveLength(0);
  });
  it("selected documentation alone produces no plan", async () => {
    const rt = baseRuntime();
    Object.assign(rt.inputs, {
      "dry-run": "true",
      "baseline-tag": "v1.2.3",
      "pull-request-numbers": "4",
    });
    const { client, created } = fakeClient({ prs: { 4: { ...pr, labels: ["documentation"] } } });
    await run(rt, { clientFactory: () => client });
    expect(rt.outputs["bump"]).toBe("none");
    expect(rt.outputs["tag"]).toBe("");
    expect(created).toHaveLength(0);
  });
});

describe("stateless publication input", () => {
  it("publishes supplied tag and notes without reading files or rediscovering a version", async () => {
    const rt = baseRuntime();
    const sha = "a".repeat(40);
    rt.inputs["publish-tag"] = "v1.0.0";
    rt.inputs["release-notes"] = "Ready";
    rt.inputs["target-commitish"] = sha;
    rt.readFile = () => {
      throw new Error("publication must not read files");
    };
    const { client, created } = fakeClient({});
    client.getLatestRelease = async () => {
      throw new Error("must not rediscover");
    };
    const publisher = Object.assign(client, {
      getTagCommit: async () => (created.length ? sha : null),
      getReleaseByTag: async () =>
        created[0]
          ? {
              id: 1,
              tagName: created[0].tagName,
              targetCommitish: sha,
              body: created[0].body,
              draft: false,
              prerelease: false,
            }
          : null,
    });
    await run(rt, { clientFactory: () => publisher });
    await run(rt, { clientFactory: () => publisher });
    expect(created).toHaveLength(1);
    expect(rt.outputs["tag"]).toBe("v1.0.0");
    expect(rt.files).toEqual({});
  });
});

describe("automatic first-release ancestry", () => {
  let dir: string;
  let rt: FakeRuntime;
  let root: string;
  let merged: string;
  let artifact: string;
  let later: string;
  let unrelated: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (title: string) => {
    git("commit", "--allow-empty", "-m", title);
    return git("rev-parse", "HEAD");
  };
  const pr = (number: number, sha: string, label = "breaking"): PullRequestRef => ({
    number,
    title: `Change ${number}`,
    author: "alice",
    labels: [label],
    url: "",
    mergeCommitSha: sha,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "label-release-ancestry-"));
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    root = commit("Initial source");
    git("checkout", "-b", "feature");
    commit("Feature work without PR trailers");
    git("checkout", "main");
    git("merge", "--no-ff", "feature", "-m", "Custom merge message");
    merged = git("rev-parse", "HEAD");
    git("checkout", "-b", "artifacts");
    artifact = commit("Generate release artifacts");
    git("checkout", "main");
    later = commit("Later squash merge");
    git("checkout", "-b", "unrelated", root);
    unrelated = commit("Other release line squash merge");
    rt = baseRuntime();
    rt.env["GITHUB_WORKSPACE"] = dir;
    rt.inputs["target-commitish"] = artifact;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([undefined, "none"])("filters artifact ancestry with baseline %s", async (baseline) => {
    if (baseline) rt.inputs["baseline-tag"] = baseline;
    const { client, created } = fakeClient({
      latestRelease: baseline ? { id: 1, tagName: "v9.0.0", targetCommitish: later } : null,
      mergedPulls: [pr(3, later), pr(2, unrelated), pr(1, merged, "bug")],
    });
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(1);
    expect(created[0]?.tagName).toBe("v0.0.1");
    expect(created[0]?.targetCommitish).toBe(artifact);
    expect(rt.outputs["notes"]).toContain("Change 1");
    expect(rt.outputs["notes"]).not.toContain("Change 2");
    expect(rt.outputs["notes"]).not.toContain("Change 3");
  });

  it.each(["sha", "branch"])("includes a merge at the target (%s)", async (kind) => {
    rt.inputs["target-commitish"] = kind === "sha" ? later : "main";
    const { client, created } = fakeClient({ mergedPulls: [pr(3, later)] });
    await run(rt, { clientFactory: () => client });
    expect(created[0]?.tagName).toBe("v1.0.0");
  });

  it("skips when no PR merge is reachable", async () => {
    const { client, created } = fakeClient({ mergedPulls: [pr(3, later), pr(2, unrelated)] });
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(0);
    expect(rt.outputs["bump"]).toBe("none");
    expect(rt.outputs["released"]).toBe("false");
  });

  it.each(["", "invalid"])("fails clearly for missing or invalid merge SHA %j", async (sha) => {
    const { client, created } = fakeClient({ mergedPulls: [pr(1, merged), pr(2, sha)] });
    await expect(run(rt, { clientFactory: () => client })).rejects.toThrow(
      /PR #2: missing or invalid merge commit SHA/,
    );
    expect(created).toHaveLength(0);
  });

  it.each(["missing target", "missing history", "shallow", "no checkout"])(
    "fails closed: %s",
    async (failure) => {
      if (failure === "missing target") rt.inputs["target-commitish"] = "not-a-commit";
      if (failure === "missing history")
        rmSync(join(dir, ".git", "objects", merged.slice(0, 2), merged.slice(2)));
      if (failure === "shallow") {
        git("clone", "--depth=1", "--branch=artifacts", `file://${dir}`, join(dir, "shallow"));
        rt.env["GITHUB_WORKSPACE"] = join(dir, "shallow");
      }
      if (failure === "no checkout") rmSync(join(dir, ".git"), { recursive: true });
      const { client, created } = fakeClient({ mergedPulls: [pr(1, merged)] });
      await expect(run(rt, { clientFactory: () => client })).rejects.toThrow(
        /Cannot establish first-release target ancestry.*fetch-depth: 0/,
      );
      expect(created).toHaveLength(0);
    },
  );
});
