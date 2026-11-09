import type { ForgejoClient } from "./forgejo.ts";
import type { PullRequestRef } from "./types.ts";

/** Attribute only the exact commits in the caller's verified baseline range. */
export async function findMergedPrs(
  client: ForgejoClient,
  commits: readonly string[],
): Promise<PullRequestRef[]> {
  await client.requireCommitPullLookup();
  const prs = new Map<number, PullRequestRef>();
  for (const sha of commits) {
    const pr = await client.getCommitPullRequest(sha);
    if (pr) prs.set(pr.number, pr);
  }
  return [...prs.values()];
}

/** With complete target history, absent SHAs are definitively not ancestors. */
export function findFirstReleasePrs(
  prs: PullRequestRef[],
  ancestors: ReadonlySet<string>,
): PullRequestRef[] {
  return prs.filter((pr) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pr.mergeCommitSha)) {
      throw new Error(
        `Cannot establish first-release ancestry for PR #${pr.number}: missing or invalid merge commit SHA.`,
      );
    }
    return ancestors.has(pr.mergeCommitSha.toLowerCase());
  });
}
