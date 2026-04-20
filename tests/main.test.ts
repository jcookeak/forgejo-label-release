import { beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/main.ts";
import type { Runtime } from "../src/runtime.ts";
import type { ForgejoClient, CreateReleaseInput } from "../src/forgejo.ts";
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
  prs?: Record<number, PullRequestRef>;
  mergedPulls?: PullRequestRef[];
}

function fakeClient(opts: FakeOptions): { client: ForgejoClient; created: CreateReleaseInput[] } {
  const created: CreateReleaseInput[] = [];
  const client: ForgejoClient = {
    listTags: async () => opts.tags ?? [],
    getLatestRelease: async () => opts.latestRelease ?? null,
    listMergedPullRequests: async () => opts.mergedPulls ?? [],
    compareCommits: async () => opts.compareCommits ?? [],
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
        1: { number: 1, title: "chore", author: "a", labels: ["chore"], url: "", mergeCommitSha: "" },
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
        10: { number: 10, title: "Add endpoint", author: "alice", labels: ["feature"], url: "", mergeCommitSha: "" },
        11: { number: 11, title: "Fix typo", author: "bob", labels: ["bug"], url: "", mergeCommitSha: "" },
      },
    });
    await run(rt, { clientFactory: () => client });
    expect(created).toHaveLength(1);
    expect(created[0]?.tagName).toBe("v1.3.0");
    expect(rt.outputs["released"]).toBe("true");
    expect(rt.outputs["bump"]).toBe("minor");
    expect(rt.outputs["previous-tag"]).toBe("v1.2.3");
  });

  it("treats missing baseline as v0.0.0 and bumps accordingly", async () => {
    const { client, created } = fakeClient({
      latestRelease: null,
      tags: [],
      mergedPulls: [
        { number: 1, title: "Break", author: "a", labels: ["breaking"], url: "", mergeCommitSha: "" },
      ],
    });
    await run(rt, { clientFactory: () => client });
    expect(created[0]?.tagName).toBe("v1.0.0");
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
});
