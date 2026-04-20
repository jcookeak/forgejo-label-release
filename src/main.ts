import { readInputs } from "./inputs.ts";
import { FetchHttp, HttpForgejoClient, type ForgejoClient } from "./forgejo.ts";
import { findMergedPrs } from "./prs.ts";
import { applyBump, decideBump, formatSemver, parseSemver, pickLatest } from "./semver.ts";
import { parseTemplate, renderNotes } from "./release-notes.ts";
import type { Runtime } from "./runtime.ts";
import type { Inputs, PullRequestRef, ReleaseTemplate, SemVer } from "./types.ts";

export interface RunDeps {
  clientFactory?: (inputs: Inputs) => ForgejoClient;
}

export async function run(rt: Runtime, deps: RunDeps = {}): Promise<void> {
  const inputs = readInputs(rt);
  const client = (deps.clientFactory ?? defaultClient)(inputs);

  const baseline = await resolveBaseline(client, inputs);
  const prs = baseline
    ? await findMergedPrs(client, baseline.tag, inputs.targetCommitish)
    : await client.listMergedPullRequests();

  rt.info(`Found ${prs.length} PR(s) since ${baseline?.tag ?? "the beginning"}.`);

  const bump = decideBump(
    prs.flatMap((pr) => pr.labels),
    { major: inputs.majorLabels, minor: inputs.minorLabels, patch: inputs.patchLabels },
  );

  if (!bump) {
    rt.info("No PR labels matched major/minor/patch configuration — skipping release.");
    rt.setOutput("released", "false");
    rt.setOutput("previous-tag", baseline?.tag ?? "");
    rt.setOutput("bump", "none");
    rt.setOutput("tag", "");
    rt.setOutput("notes", "");
    return;
  }

  const baseVersion: SemVer = baseline?.version ?? { major: 0, minor: 0, patch: 0 };
  const nextVersion = applyBump(baseVersion, bump);
  const newTag = formatSemver(nextVersion, inputs.tagPrefix);

  const template = loadTemplate(rt, inputs.releaseTemplatePath);
  const notes = renderNotes(prs, template, {
    previousTag: baseline?.tag ?? null,
    newTag,
    compareUrl: baseline
      ? `${inputs.serverUrl}/${inputs.owner}/${inputs.repo}/compare/${baseline.tag}...${newTag}`
      : undefined,
  });

  rt.info(`Computed ${bump} bump: ${baseline?.tag ?? "(none)"} -> ${newTag}`);

  if (!inputs.dryRun) {
    await client.createRelease({
      tagName: newTag,
      targetCommitish: inputs.targetCommitish,
      name: newTag,
      body: notes,
      draft: inputs.draft,
      prerelease: inputs.prerelease,
    });
    rt.info(`Created release ${newTag}.`);
  } else {
    rt.info("dry-run: skipping release creation.");
  }

  rt.setOutput("released", inputs.dryRun ? "false" : "true");
  rt.setOutput("previous-tag", baseline?.tag ?? "");
  rt.setOutput("bump", bump);
  rt.setOutput("tag", newTag);
  rt.setOutput("notes", notes);
}

async function resolveBaseline(
  client: ForgejoClient,
  inputs: Inputs,
): Promise<{ tag: string; version: SemVer } | null> {
  const latest = await client.getLatestRelease();
  if (latest) {
    const v = parseSemver(latest.tagName, inputs.tagPrefix);
    if (v) return { tag: latest.tagName, version: v };
  }
  const tags = await client.listTags();
  return pickLatest(tags, inputs.tagPrefix);
}

function loadTemplate(rt: Runtime, path: string): ReleaseTemplate | null {
  const src = rt.readFile(path);
  if (!src) return null;
  try {
    return parseTemplate(src);
  } catch (err) {
    rt.warn(`Failed to parse release template at ${path}: ${(err as Error).message}`);
    return null;
  }
}

function defaultClient(inputs: Inputs): ForgejoClient {
  return new HttpForgejoClient(
    new FetchHttp(inputs.serverUrl, inputs.token),
    inputs.owner,
    inputs.repo,
  );
}
