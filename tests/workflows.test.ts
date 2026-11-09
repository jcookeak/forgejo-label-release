import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
}
interface Job {
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflowDir = new URL("../.forgejo/workflows/", import.meta.url);
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => {
    const source = readFileSync(new URL(name, workflowDir), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    return { name, source, document, workflow: document.toJS() as Workflow };
  });

function workflow(name: string): Workflow {
  return workflows.find((entry) => entry.name === name)!.workflow;
}
function step(name: string, stepName: string): Step {
  return Object.values(workflow(name).jobs)
    .flatMap((job) => job.steps)
    .find((entry) => entry.name === stepName)!;
}

// Model the runner's source substitution separately from shell environment data.
function render(source: string, context: Record<string, string>): string {
  return source.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
    if (!(expression in context)) throw new Error(`Unbound expression: ${expression}`);
    return context[expression]!;
  });
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "label-release-workflows-"));
  directories.push(directory);
  return directory;
}

// Do not inherit credentials, Git helpers, or tracing from the developer machine.
const environment = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: environment, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function runStep(
  entry: Step,
  cwd: string,
  context: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
) {
  for (const path of ["scripts", "src"])
    if (!existsSync(join(cwd, path)))
      symlinkSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), join(cwd, path));
  return spawnSync("bash", ["-c", render(entry.run!, context)], {
    cwd,
    env: {
      ...environment,
      FORGEJO_OUTPUT: join(cwd, "output"),
      ...Object.fromEntries(
        Object.entries(entry.env ?? {}).map(([key, value]) => [key, render(value, context)]),
      ),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}
function repository() {
  const cwd = temporaryDirectory();
  const remote = join(cwd, "remote.git");
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Workflow Test");
  git(cwd, "config", "user.email", "workflow-test@example.invalid");
  git(cwd, "commit", "--allow-empty", "-m", "source");
  const sha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "init", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  return { cwd, remote, sha };
}

const hostileBranch = "fix/$(touch${IFS}PWNED)";
const tokenContext = { "secrets.GITHUB_TOKEN": "test-only-token" };

describe("hostile event metadata", () => {
  it("proves the payload is a valid Git branch and executes when interpolated into shell source", () => {
    const cwd = temporaryDirectory();
    expect(git(cwd, "check-ref-format", "--branch", hostileBranch)).toBe(hostileBranch);
    const control = runStep({ run: `printf '%s\\n' "HEAD:${hostileBranch}"` }, cwd);
    expect(control.status).toBe(0);
    expect(existsSync(join(cwd, "PWNED"))).toBe(true);
  });

  it("validates the immutable PR SHA without executing a hostile head ref", () => {
    const cwd = temporaryDirectory();
    const context = {
      "github.event.pull_request.head.ref": hostileBranch,
      "github.event.pull_request.head.sha": "a".repeat(40),
    };
    const result = runStep(step("ci.yml", "Validate PR commit"), cwd, context);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(cwd, "PWNED"))).toBe(false);
    context["github.event.pull_request.head.sha"] = hostileBranch;
    expect(runStep(step("ci.yml", "Validate PR commit"), cwd, context).status).not.toBe(0);
    expect(existsSync(join(cwd, "PWNED"))).toBe(false);
  });

  it("uses the published tag's commit even when target_commitish is a hostile or moving branch", () => {
    const { cwd, remote, sha } = repository();
    git(cwd, "tag", "-a", "v1.2.3", "-m", "released", sha);
    git(cwd, "push", "origin", "refs/tags/v1.2.3");
    git(cwd, "commit", "--allow-empty", "-m", "later branch tip");
    git(cwd, "branch", hostileBranch);
    const result = runStep(step("floating-tags.yml", "Move floating tags"), cwd, {
      ...tokenContext,
      "github.event.release.tag_name": "v1.2.3",
      "github.event.release.target_commitish": hostileBranch,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(cwd, "PWNED"))).toBe(false);
    expect(
      git(cwd, "--git-dir", remote, "rev-parse", "refs/tags/v1", "refs/tags/v1.2").split("\n"),
    ).toEqual([sha, sha]);
    expect(readFileSync(join(cwd, ".git/config"), "utf8")).not.toMatch(
      /test-only-token|extraheader/i,
    );
  });

  it.each(["release.yml", "floating-tags.yml"])(
    "skips prerelease and hostile tag data in %s",
    (name) => {
      const { cwd, remote, sha } = repository();
      for (const tag of ["v1.2.3-rc.1", `v1.2.3-$(touch\${IFS}PWNED)`, "--help", "v01.2.3"]) {
        const result = runStep(step(name, "Move floating tags"), cwd, {
          ...tokenContext,
          "steps.release.outputs.tag": tag,
          "steps.artifacts.outputs.sha": sha,
          "github.event.release.tag_name": tag,
          "github.event.release.target_commitish": hostileBranch,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(join(cwd, "PWNED"))).toBe(false);
        expect(
          git(cwd, "--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/tags"),
        ).toBe("");
      }
    },
  );
});
