import type { Runtime } from "./runtime.ts";
import type { Inputs } from "./types.ts";

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  throw new Error(`Expected boolean, got '${raw}'`);
}

function parseRepository(repoSpec: string): { owner: string; repo: string } {
  const parts = repoSpec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository '${repoSpec}'. Expected 'owner/repo'.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function readInputs(rt: Runtime): Inputs {
  const token =
    rt.getInput("token") ??
    rt.getEnv("GITHUB_TOKEN") ??
    rt.getEnv("FORGEJO_TOKEN");
  if (!token) throw new Error("Missing 'token' input (or GITHUB_TOKEN/FORGEJO_TOKEN env).");

  const serverUrl =
    rt.getInput("server-url") ?? rt.getEnv("GITHUB_SERVER_URL");
  if (!serverUrl) throw new Error("Missing 'server-url' input (or GITHUB_SERVER_URL env).");

  const repoSpec = rt.getInput("repository") ?? rt.getEnv("GITHUB_REPOSITORY");
  if (!repoSpec) throw new Error("Missing 'repository' input (or GITHUB_REPOSITORY env).");
  const { owner, repo } = parseRepository(repoSpec);

  const targetCommitish =
    rt.getInput("target-commitish") ?? rt.getEnv("GITHUB_SHA");
  if (!targetCommitish) throw new Error("Missing 'target-commitish' input (or GITHUB_SHA env).");

  return {
    token,
    serverUrl: serverUrl.replace(/\/+$/, ""),
    owner,
    repo,
    targetCommitish,
    majorLabels: splitList(rt.getInput("major-labels")),
    minorLabels: splitList(rt.getInput("minor-labels")),
    patchLabels: splitList(rt.getInput("patch-labels")),
    tagPrefix: rt.getInput("tag-prefix") ?? "v",
    releaseTemplatePath: rt.getInput("release-template") ?? ".forgejo/release.yml",
    draft: parseBool(rt.getInput("draft"), false),
    prerelease: parseBool(rt.getInput("prerelease"), false),
    dryRun: parseBool(rt.getInput("dry-run"), false),
  };
}
