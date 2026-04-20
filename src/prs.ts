import type { ForgejoClient } from "./forgejo.ts";
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
): Promise<PullRequestRef[]> {
  const commits = await client.compareCommits(base, head);
  const numbers = extractPrNumbers(commits.map((c) => c.message));
  const prs = await Promise.all(numbers.map((n) => client.getPullRequest(n)));
  return prs;
}
