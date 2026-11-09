import { ForgejoApiError, type ForgejoClient } from "./forgejo.ts";
import type { PullRequestRef } from "./types.ts";

const MERGE_COMMIT_RE = /^Merge pull request #(\d+)/m;
const SQUASH_TITLE_RE = /\(#(\d+)\)\s*$/m;

export function extractPrNumbers(commitMessages: string[]): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const msg of commitMessages) {
    const n = extractPrNumber(msg);
    if (n === null) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    ordered.push(n);
  }
  return ordered;
}

export function extractPrNumber(message: string): number | null {
  const firstLine = message.split("\n", 1)[0] ?? "";
  const squash = SQUASH_TITLE_RE.exec(firstLine);
  if (squash?.[1]) return Number(squash[1]);
  const merge = MERGE_COMMIT_RE.exec(message);
  if (merge?.[1]) return Number(merge[1]);
  return null;
}

export async function findMergedPrs(
  client: ForgejoClient,
  base: string,
  head: string,
  opts: { baselineTargetCommitish?: string } = {},
): Promise<PullRequestRef[]> {
  try {
    const commits = await client.compareCommits(base, head);
    const numbers = extractPrNumbers(commits.map((c) => c.message));
    const prs = await Promise.all(numbers.map((n) => client.getPullRequest(n)));
    return prs;
  } catch (err) {
    if (!(err instanceof ForgejoApiError) || err.status !== 404) throw err;
    return prsSinceBaselineTarget(
      await client.listMergedPullRequests(),
      opts.baselineTargetCommitish,
      head,
    );
  }
}

function prsSinceBaselineTarget(
  prs: PullRequestRef[],
  baselineTargetCommitish: string | undefined,
  head: string,
): PullRequestRef[] {
  // A release may be rerun after another PR has merged. When the requested
  // commit identifies a merged PR, exclude changes newer than that commit.
  const headIndex = prs.findIndex((pr) => pr.mergeCommitSha === head);
  if (headIndex >= 0) prs = prs.slice(headIndex);
  if (!baselineTargetCommitish) return prs;
  const baselineIndex = prs.findIndex((pr) => pr.mergeCommitSha === baselineTargetCommitish);
  return baselineIndex === -1 ? prs : prs.slice(0, baselineIndex);
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
