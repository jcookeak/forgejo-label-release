import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  cpSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { publishExplicit } from "../src/publish.ts";
import { run as runAction } from "../src/main.ts";
import type { Runtime } from "../src/runtime.ts";
import type { ForgejoClient, ReleasePublisherClient, CreateReleaseInput } from "../src/forgejo.ts";
import type { ReleaseRef } from "../src/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = parse(readFileSync(join(root, ".forgejo/workflows/release.yml"), "utf8"));
const directories: string[] = [];
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "self-release-test-"));
  directories.push(cwd);
  const remote = join(cwd, "remote.git");
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.invalid");
  writeFileSync(join(cwd, "source"), "trusted source\n");
  git(cwd, "add", "source");
  git(cwd, "commit", "-m", "source");
  const source = git(cwd, "rev-parse", "HEAD");
  git(cwd, "init", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "main");
  for (const path of ["scripts", "src"]) symlinkSync(join(root, path), join(cwd, path));
  mkdirSync(join(cwd, "dist"));
  writeFileSync(join(cwd, "dist/index.js"), "// built artifact\n");
  const run = (name: string, extra: Record<string, string> = {}) => {
    const step = release.jobs.release.steps.find((s: { name?: string }) => s.name === name);
    const output = join(cwd, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", step.run], {
      cwd,
      env: {
        ...env,
        FORGEJO_OUTPUT: output,
        TOKEN: "test-only-token",
        SOURCE_SHA: git(cwd, "rev-parse", "HEAD"),
        TAG: "v1.2.3",
        NOTES: "Planned notes\n\nMore notes.",
        BUMP: "patch",
        PREVIOUS_TAG: "v1.2.2",
        ...extra,
      },
      encoding: "utf8",
    });
    const outputs: Record<string, string> = {};
    const lines = readFileSync(output, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const [key, delimiter] = lines[i]!.split("<<");
      if (!key || !delimiter) continue;
      const end = lines.indexOf(delimiter, i + 1);
      if (end < 0) throw new Error("Malformed action output");
      outputs[key] = lines.slice(i + 1, end).join("\n");
      i = end;
    }
    return { ...result, outputs };
  };
  const artifact = (extra: Record<string, string> = {}) =>
    run("Publish version artifacts branch", extra);
  const ref = (name: string) => git(cwd, "--git-dir", remote, "rev-parse", name);
  return { cwd, source, remote, run, artifact, ref };
}
function publisher(cwd: string, remote: string) {
  let release: ReleaseRef | null = null;
  let fail = false;
  let posts = 0;
  const undiscovered = async (): Promise<never> => {
    throw new Error("must not rediscover during publication");
  };
  const client: ForgejoClient & ReleasePublisherClient = {
    listTags: undiscovered,
    getLatestRelease: undiscovered,
    requireCommitPullLookup: undiscovered,
    getCommitPullRequest: undiscovered,
    getPullRequest: undiscovered,
    listMergedPullRequests: undiscovered,
    getReleaseByTag: async () => release,
    getTagCommit: async (tag: string) => {
      const found = git(cwd, "ls-remote", "origin", `refs/tags/${tag}`);
      return found ? found.split("\t")[0]! : null;
    },
    createRelease: async (input: CreateReleaseInput) => {
      posts++;
      if (fail) throw new Error("publication failed");
      git(
        cwd,
        "--git-dir",
        remote,
        "update-ref",
        `refs/tags/${input.tagName}`,
        input.targetCommitish,
      );
      release = {
        id: 1,
        tagName: input.tagName,
        targetCommitish: input.targetCommitish,
        body: input.body,
        draft: input.draft,
        prerelease: input.prerelease,
      };
      return release;
    },
  };
  return {
    client,
    setFail: (value: boolean) => {
      fail = value;
    },
    posts: () => posts,
  };
}
async function planAt(f: ReturnType<typeof fixture>, labels: string[], baseline?: string) {
  const outputs: Record<string, string> = {};
  const target = git(f.cwd, "rev-parse", "HEAD");
  const pr = {
    number: 42,
    title: "Source change",
    author: "test",
    labels,
    url: "https://example.invalid/pulls/42",
    mergeCommitSha: target,
  };
  const inputs: Record<string, string> = {
    token: "test-only-token",
    "server-url": "https://example.invalid",
    repository: "test/action",
    "target-commitish": target,
    "major-labels": "breaking",
    "minor-labels": "enhancement",
    "patch-labels": "bug,dependency",
    "dry-run": "true",
  };
  const rt: Runtime = {
    getInput: (name) => inputs[name],
    getEnv: (name) => (name === "GITHUB_WORKSPACE" ? f.cwd : undefined),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    readFile: () => undefined,
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const client: ForgejoClient = {
    getLatestRelease: async () =>
      baseline ? { id: 1, tagName: baseline, targetCommitish: "moving-branch" } : null,
    listTags: async () => [],
    listMergedPullRequests: async () => [pr],
    requireCommitPullLookup: async () => {},
    getCommitPullRequest: async (commit) => {
      // With the previous artifact as baseline, only the new source commit belongs in this range.
      expect(commit).toBe(target);
      return pr;
    },
    getPullRequest: async () => {
      throw new Error("must discover by source ancestry");
    },
    createRelease: async () => {
      throw new Error("dry-run must not publish");
    },
  };
  await runAction(rt, { clientFactory: () => client });
  return outputs;
}
function publication(outputs: Record<string, string>): CreateReleaseInput {
  return {
    tagName: outputs.tag!,
    targetCommitish: outputs.sha!,
    body: outputs.notes!,
    name: outputs.tag!,
    draft: false,
    prerelease: false,
  };
}

describe("repository self-release", () => {
  it("builds the real action and publishes a version branch and tag at the identical generated commit", async () => {
    const f = fixture();
    // Use the same build command as the workflow, with already installed locked dependencies.
    // Copy source into this isolated checkout so compilation cannot modify the working repo.
    rmSync(join(f.cwd, "src"));
    cpSync(join(root, "src"), join(f.cwd, "src"), { recursive: true });
    for (const path of ["package.json", "tsconfig.build.json", "tsconfig.json"])
      cpSync(join(root, path), join(f.cwd, path));
    symlinkSync(join(root, "node_modules"), join(f.cwd, "node_modules"));
    git(f.cwd, "add", "src", "package.json", "tsconfig.build.json", "tsconfig.json");
    git(f.cwd, "commit", "-m", "action source");
    const source = git(f.cwd, "rev-parse", "HEAD");
    const build = spawnSync("npm", ["run", "build"], { cwd: f.cwd, env, encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    const built = f.artifact();
    expect(built.status, built.stdout + built.stderr).toBe(0);
    const commit = built.outputs.sha!;
    expect(f.ref("refs/heads/releases/v1.2.3")).toBe(commit);
    expect(git(f.cwd, "rev-parse", `${commit}^`)).toBe(source);
    expect(git(f.cwd, "show", `${commit}:dist/index.js`)).toContain("publish-tag");
    expect(git(f.cwd, "show", `${commit}:dist/index.js`)).toBe(
      readFileSync(join(f.cwd, "dist/index.js"), "utf8").trim(),
    );
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(source);
    const p = publisher(f.cwd, f.remote);
    await publishExplicit(p.client, publication(built.outputs));
    expect(f.ref("refs/tags/v1.2.3")).toBe(commit);
    const moved = f.run("Move floating tags", { ARTIFACT_SHA: commit });
    expect(moved.status, moved.stdout).toBe(0);
    expect(f.ref("refs/tags/v1")).toBe(commit);
    expect(f.ref("refs/tags/v1.2")).toBe(commit);
    expect(readFileSync(join(f.cwd, ".git/config"), "utf8")).not.toMatch(
      /test-only-token|extraheader/i,
    );
    expect(built.stdout + built.stderr + moved.stdout + moved.stderr).not.toContain(
      "test-only-token",
    );
  }, 30_000);

  it("plans from the source range against a sibling artifact baseline before creating the new build commit", async () => {
    const f = fixture();
    const previous = f.artifact({ TAG: "v1.2.2", PREVIOUS_TAG: "v1.2.1" });
    expect(previous.status, previous.stdout).toBe(0);
    git(f.cwd, "tag", "v1.2.2", previous.outputs.sha!);
    git(f.cwd, "commit", "--allow-empty", "-m", "merged source change");
    const source = git(f.cwd, "rev-parse", "HEAD");
    const plan = await planAt(f, ["bug"], "v1.2.2");
    expect(plan).toMatchObject({ tag: "v1.2.3", bump: "patch", released: "false" });
    expect(plan.notes).toContain("Source change");
    const built = f.artifact({
      TAG: plan.tag!,
      NOTES: plan.notes!,
      BUMP: plan.bump!,
      PREVIOUS_TAG: plan["previous-tag"]!,
    });
    expect(built.status, built.stdout).toBe(0);
    expect(git(f.cwd, "rev-parse", `${built.outputs.sha}^`)).toBe(source);
    const p = publisher(f.cwd, f.remote);
    await publishExplicit(p.client, publication(built.outputs));
    expect(f.ref("refs/tags/v1.2.3")).toBe(f.ref("refs/heads/releases/v1.2.3"));
    expect(f.ref("refs/tags/v1.2.3")).not.toBe(source);
  });

  it("does no branch or tag writes for no-bump", async () => {
    const f = fixture();
    const plan = await planAt(f, ["documentation"]);
    expect(plan).toMatchObject({ tag: "", bump: "none", released: "false" });
    const result = f.artifact({ TAG: plan.tag!, BUMP: plan.bump! });
    expect(result.status, result.stdout).toBe(0);
    expect(result.outputs.sha).toBe("");
    expect(git(f.cwd, "ls-remote", "origin", "refs/heads/releases/*", "refs/tags/*")).toBe("");
  });

  it("recovers exact notes/version and reuses a matching tree despite changed commit timestamps after API failure", async () => {
    const f = fixture();
    const first = f.artifact({
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    });
    expect(first.status, first.stdout).toBe(0);
    const p = publisher(f.cwd, f.remote);
    p.setFail(true);
    await expect(publishExplicit(p.client, publication(first.outputs))).rejects.toThrow(
      "publication failed",
    );
    // No floating aliases exist before publication succeeds.
    expect(git(f.cwd, "ls-remote", "origin", "refs/tags/*")).toBe("");
    const recovery = f.run("Recover source release plan");
    expect(recovery.status, recovery.stdout).toBe(0);
    expect(recovery.outputs).toMatchObject({
      recovered: "true",
      tag: first.outputs.tag,
      notes: first.outputs.notes,
    });
    const retry = f.artifact({
      TAG: recovery.outputs.tag!,
      NOTES: recovery.outputs.notes!,
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    });
    expect(retry.status, retry.stdout).toBe(0);
    expect(retry.outputs.sha).toBe(first.outputs.sha);
    p.setFail(false);
    await publishExplicit(p.client, publication(retry.outputs));
    // A completed source recovers its original version even after publication changed the baseline.
    expect(f.run("Recover source release plan").outputs.tag).toBe(first.outputs.tag);
    await publishExplicit(p.client, publication(retry.outputs));
    expect(p.posts()).toBe(2);
    expect(f.artifact({ TAG: "v1.2.4" }).status).not.toBe(0);
    expect(git(f.cwd, "ls-remote", "origin", "refs/heads/releases/v1.2.4")).toBe("");
  });

  it("preserves a conflicting version branch, including a fast-forward candidate", () => {
    const f = fixture();
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/heads/releases/v1.2.3", f.source);
    const result = f.artifact();
    expect(result.status).not.toBe(0);
    expect(f.ref("refs/heads/releases/v1.2.3")).toBe(f.source);
    expect(result.outputs.sha).toBeUndefined();
  });

  it("rejects changed source, built files and notes without rewriting branches", () => {
    const f = fixture();
    const first = f.artifact();
    expect(first.status, first.stdout).toBe(0);
    expect(f.artifact({ NOTES: "changed" }).status).not.toBe(0);
    writeFileSync(join(f.cwd, "dist/index.js"), "// changed\n");
    expect(f.artifact().status).not.toBe(0);
    writeFileSync(join(f.cwd, "dist/index.js"), "// built artifact\n");
    git(f.cwd, "commit", "--allow-empty", "-m", "new source");
    expect(f.artifact().status).not.toBe(0);
    expect(f.ref("refs/heads/releases/v1.2.3")).toBe(first.outputs.sha);
  });

  it("fails a racing creation safely using an absent-ref lease", () => {
    const f = fixture();
    // The remote installs a competing ref after negotiation, immediately before update.
    const hook = join(f.remote, "hooks/pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nunset GIT_QUARANTINE_PATH\ngit --git-dir='${f.remote}' update-ref refs/heads/releases/v1.2.3 '${f.source}'\n`,
      { mode: 0o755 },
    );
    const loser = f.artifact();
    expect(loser.status).not.toBe(0);
    expect(loser.outputs.sha).toBeUndefined();
    expect(f.ref("refs/heads/releases/v1.2.3")).toBe(f.source);
    expect(git(f.cwd, "ls-remote", "origin", "refs/tags/*")).toBe("");
  });

  it("rejects an alias update race instead of overwriting its winner", () => {
    const f = fixture();
    const built = f.artifact();
    expect(built.status, built.stdout).toBe(0);
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/tags/v1.2.3", built.outputs.sha!);
    writeFileSync(
      join(f.remote, "hooks/pre-receive"),
      `#!/bin/sh\nunset GIT_QUARANTINE_PATH\ngit --git-dir='${f.remote}' update-ref refs/tags/v1 '${f.source}'\n`,
      { mode: 0o755 },
    );
    const loser = f.run("Move floating tags", { ARTIFACT_SHA: built.outputs.sha! });
    expect(loser.status).not.toBe(0);
    expect(f.ref("refs/tags/v1")).toBe(f.source);
    expect(f.ref("refs/tags/v1.2.3")).toBe(built.outputs.sha);
    expect(git(f.cwd, "ls-remote", "origin", "refs/tags/v1.2")).toBe("");
  });

  it("rejects shallow or modified source checkouts before writing refs", () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "source"), "modified source\n");
    expect(f.artifact().status).not.toBe(0);
    git(f.cwd, "restore", "source");
    writeFileSync(join(f.cwd, ".git/shallow"), `${f.source}\n`);
    expect(f.artifact().status).not.toBe(0);
    expect(f.run("Recover source release plan").status).not.toBe(0);
    expect(git(f.cwd, "ls-remote", "origin", "refs/heads/releases/*", "refs/tags/*")).toBe("");
  });

  it("recovers after an ambiguous push without creating a second artifact", () => {
    const f = fixture();
    const first = f.artifact();
    expect(first.status, first.stdout).toBe(0);
    // Losing all runner-local state models a completed push whose response/output was lost.
    git(f.cwd, "update-ref", "-d", "refs/self-release/branches/v1.2.3");
    const recovered = f.run("Recover source release plan");
    expect(recovered.outputs.recovered).toBe("true");
    const retry = f.artifact({ GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" });
    expect(retry.status, retry.stdout).toBe(0);
    expect(retry.outputs.sha).toBe(first.outputs.sha);
  });

  it("rejects conflicting tags/releases and does not move floating aliases", async () => {
    const f = fixture();
    const built = f.artifact();
    const p = publisher(f.cwd, f.remote);
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/tags/v1.2.3", f.source);
    await expect(publishExplicit(p.client, publication(built.outputs))).rejects.toThrow(
      "different commit",
    );
    expect(p.posts()).toBe(0);
    expect(f.run("Move floating tags", { ARTIFACT_SHA: built.outputs.sha! }).status).not.toBe(0);
    expect(git(f.cwd, "ls-remote", "origin", "refs/tags/v1", "refs/tags/v1.2")).toBe("");
  });

  it("keeps hostile metadata as data and validates all source/version inputs", () => {
    const f = fixture();
    const notes = "$(touch PWNED)\n::warning::hostile\nnotes<<EOF\n`touch PWNED`\n";
    const built = f.artifact({ NOTES: notes });
    expect(built.status, built.stdout).toBe(0);
    expect(f.run("Recover source release plan").outputs.notes).toBe(notes);
    for (const bad of [
      "--help",
      "v01.2.3",
      "v1.2.3/evil",
      "v1.2.3-$(touch${IFS}PWNED)",
      "v1.2.3\nBAD=1",
    ])
      expect(f.artifact({ TAG: bad }).status).not.toBe(0);
    for (const bad of ["HEAD", "--help", "$(touch PWNED)", "a".repeat(40), f.source.toUpperCase()])
      expect(f.artifact({ SOURCE_SHA: bad }).status).not.toBe(0);
    expect(existsSync(join(f.cwd, "PWNED"))).toBe(false);
  });

  it("keeps main, historical artifacts and tags untouched and prevents alias rollback on old retries", () => {
    const f = fixture();
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/heads/release-artifacts", f.source);
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/tags/v0.9.0", f.source);
    const old = f.artifact();
    expect(old.status, old.stdout).toBe(0);
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/tags/v1.2.3", old.outputs.sha!);
    git(f.cwd, "commit", "--allow-empty", "-m", "next source");
    const newer = f.artifact({ TAG: "v1.3.0", BUMP: "minor", PREVIOUS_TAG: "v1.2.3" });
    expect(newer.status, newer.stdout).toBe(0);
    git(f.cwd, "--git-dir", f.remote, "update-ref", "refs/tags/v1.3.0", newer.outputs.sha!);
    expect(
      f.run("Move floating tags", { TAG: "v1.3.0", ARTIFACT_SHA: newer.outputs.sha! }).status,
    ).toBe(0);
    expect(f.run("Move floating tags", { ARTIFACT_SHA: old.outputs.sha! }).status).toBe(0);
    expect(f.ref("refs/tags/v1")).toBe(newer.outputs.sha);
    expect(f.ref("refs/tags/v1.3")).toBe(newer.outputs.sha);
    expect(f.ref("refs/tags/v1.2")).toBe(old.outputs.sha);
    expect(f.ref("refs/heads/main")).toBe(f.source);
    expect(f.ref("refs/heads/release-artifacts")).toBe(f.source);
    expect(f.ref("refs/tags/v0.9.0")).toBe(f.source);
    expect(f.ref("refs/heads/releases/v1.2.3")).toBe(old.outputs.sha);
  });
});
