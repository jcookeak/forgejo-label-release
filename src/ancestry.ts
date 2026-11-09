import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Complete target history, including the target itself; never fetches or modifies Git. */
export async function targetAncestors(target: string, cwd?: string): Promise<Set<string>> {
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["--no-replace-objects", ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  };
  try {
    if ((await git("rev-parse", "--is-shallow-repository")) !== "false") {
      throw new Error("checkout is shallow");
    }
    const sha = await git("rev-parse", "--verify", "--end-of-options", `${target}^{commit}`);
    const history = await git("rev-list", sha, "--");
    return new Set(history.split("\n"));
  } catch (err) {
    throw new Error(
      "Cannot establish first-release target ancestry. Check out the release repository with " +
        "fetch-depth: 0 and ensure target-commitish and its complete history are available locally.",
      { cause: err },
    );
  }
}

/** Exact reachable-set difference, including side branches and sibling artifact heads. */
export async function baselineCommits(
  baseTag: string,
  target: string,
  cwd?: string,
): Promise<string[]> {
  try {
    const baseline = await targetAncestors(`refs/tags/${baseTag}`, cwd);
    const head = await targetAncestors(target, cwd);
    return [...head].filter((sha) => !baseline.has(sha));
  } catch (err) {
    throw new Error(
      "Cannot establish release baseline range. Check out the release repository with " +
        "fetch-depth: 0 and ensure the baseline tag, target-commitish and both complete histories are available locally.",
      { cause: err },
    );
  }
}
