// Repository self-release plumbing, deliberately outside the reusable action.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRuntime } from "../src/runtime.ts";

const rt = new ActionRuntime();
const planPath = ".forgejo/self-release-plan.json";
const namespace = "refs/self-release/branches/";
// The final assertion anchors at the real end, including after hostile newline data.
const stable = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;
interface Plan {
  source: string;
  tag: string;
  notes: string;
  bump: string;
  previousTag: string;
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
function sha(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/.test(value))
    throw new Error("Invalid commit SHA.");
  return value;
}
function tag(value: string): string {
  if (!stable.test(value)) throw new Error("Expected a stable vX.Y.Z tag.");
  git(["check-ref-format", `refs/tags/${value}`]);
  return value;
}
function git(args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("git", ["--no-replace-objects", ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Never surface auth headers, helper output, command environments or remote diagnostics.
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed (exit ${result.status}).`);
  return result.stdout.trim();
}
function remote(args: string[]): string {
  const token = requireValue(process.env.TOKEN, "TOKEN");
  return git(args, undefined, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  });
}
function source(): string {
  const value = sha(requireValue(process.env.SOURCE_SHA, "SOURCE_SHA"));
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false")
    throw new Error("Self-release requires full history.");
  if (git(["rev-parse", "HEAD"]) !== value)
    throw new Error("Checkout must remain at the immutable source SHA.");
  git(["cat-file", "-e", `${value}^{commit}`]);
  git(["diff", "--exit-code", "HEAD", "--", ".", ":(exclude)dist"]);
  return value;
}
function validatePlan(value: unknown): Plan {
  if (!value || typeof value !== "object") throw new Error("Invalid self-release plan.");
  const p = value as Plan;
  sha(p.source);
  tag(p.tag);
  if (
    typeof p.notes !== "string" ||
    !["major", "minor", "patch"].includes(p.bump) ||
    typeof p.previousTag !== "string" ||
    (p.previousTag !== "" && !stable.test(p.previousTag))
  )
    throw new Error("Invalid self-release plan.");
  return { source: p.source, tag: p.tag, notes: p.notes, bump: p.bump, previousTag: p.previousTag };
}
function branches(): { plan: Plan; commit: string }[] {
  remote(["fetch", "--no-tags", "--prune", "origin", `+refs/heads/releases/*:${namespace}*`]);
  const refs = git(["for-each-ref", "--format=%(refname)", namespace]);
  if (!refs) return [];
  return refs.split("\n").map((ref) => {
    const version = tag(ref.slice(namespace.length));
    const commit = sha(git(["rev-parse", "--verify", ref]));
    let parsed: unknown;
    try {
      parsed = JSON.parse(git(["show", `${commit}:${planPath}`]));
    } catch {
      throw new Error("Version branch has missing or malformed self-release metadata.");
    }
    const plan = validatePlan(parsed);
    if (
      plan.tag !== version ||
      git(["rev-list", "--parents", "-n", "1", commit]) !== `${commit} ${plan.source}`
    )
      throw new Error("Version branch has conflicting source ancestry or plan.");
    if (git(["cat-file", "-t", `${commit}:dist/index.js`]) !== "blob")
      throw new Error("Version branch lacks the generated action.");
    return { plan, commit };
  });
}
function emit(plan: Plan, commit?: string): void {
  rt.setOutput("tag", plan.tag);
  rt.setOutput("notes", plan.notes);
  rt.setOutput("bump", plan.bump);
  rt.setOutput("previous-tag", plan.previousTag);
  if (commit) rt.setOutput("sha", commit);
}
function recover(): void {
  const at = source();
  const matches = branches().filter(({ plan }) => plan.source === at);
  if (matches.length > 1)
    throw new Error("Multiple release plans for this source; reconcile manually.");
  rt.setOutput("recovered", matches.length ? "true" : "false");
  if (matches[0]) emit(matches[0].plan);
}
function artifacts(): void {
  const at = source();
  const version = process.env.TAG ?? "";
  if (!version) {
    rt.setOutput("sha", "");
    return; // no-bump: no branch or tag writes
  }
  const plan = validatePlan({
    source: at,
    tag: version,
    notes: process.env.NOTES ?? "",
    bump: process.env.BUMP,
    previousTag: process.env.PREVIOUS_TAG ?? "",
  });
  const ref = `refs/heads/releases/${plan.tag}`;
  git(["check-ref-format", ref]);
  const directory = mkdtempSync(join(tmpdir(), "self-release-index-"));
  let tree: string;
  try {
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    git(["read-tree", at], undefined, env);
    git(["add", "-f", "--", "dist/"], undefined, env);
    const blob = git(["hash-object", "-w", "--stdin"], JSON.stringify(plan) + "\n");
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${planPath}`], undefined, env);
    tree = git(["write-tree"], undefined, env);
    if (git(["cat-file", "-t", `${tree}:dist/index.js`]) !== "blob")
      throw new Error("Build dist/index.js before publishing artifacts.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const existing = branches();
  if (existing.some(({ plan: p }) => p.source === at && p.tag !== plan.tag))
    throw new Error("This source already has another release plan; recover it instead.");
  const reuse = (entry: { plan: Plan; commit: string }): void => {
    if (git(["rev-parse", `${entry.commit}^{tree}`]) !== tree)
      throw new Error(
        "Existing version branch conflicts with the planned notes or built contents.",
      );
    if (entry.plan.source !== at) throw new Error("Existing version branch has another source.");
    emit(plan, entry.commit);
  };
  const found = existing.find(({ plan: p }) => p.tag === plan.tag);
  if (found) return reuse(found);
  const commit = sha(
    git(["commit-tree", tree, "-p", at], `chore: build ${plan.tag}\n`, {
      GIT_AUTHOR_NAME: "forgejo-actions[bot]",
      GIT_AUTHOR_EMAIL: "forgejo-actions[bot]@users.noreply.forgejo.org",
      GIT_COMMITTER_NAME: "forgejo-actions[bot]",
      GIT_COMMITTER_EMAIL: "forgejo-actions[bot]@users.noreply.forgejo.org",
    }),
  );
  // The empty lease requires an absent ref, even if the proposed update would fast-forward.
  // A failed/ambiguous push is retried by recovering the remote branch on the next run.
  remote(["push", `--force-with-lease=${ref}:`, "origin", `${commit}:${ref}`]);
  emit(plan, commit);
}

function floating(): void {
  const value = requireValue(process.env.TAG, "TAG");
  if (!stable.test(value)) {
    rt.info("Not a stable semver tag — skipping floating tags.");
    return;
  }
  const version = tag(value);
  // Read fresh tag refs: annotated version tags must be peeled to the actual commit.
  const refs = remote(["ls-remote", "--tags", "origin"]);
  const tags = new Map(
    refs
      ? refs.split("\n").map((line) => {
          const [object, ref] = line.split("\t");
          return [ref!, sha(object!)];
        })
      : [],
  );
  const target = tags.get(`refs/tags/${version}^{}`) ?? tags.get(`refs/tags/${version}`);
  if (!target) throw new Error("Published version tag is missing.");
  git(["cat-file", "-e", `${target}^{commit}`]);
  const supplied = process.env.ARTIFACT_SHA;
  if (supplied && sha(supplied) !== target)
    throw new Error("Published tag differs from the planned artifact commit.");
  const parts = stable
    .exec(version)!
    .slice(1)
    .map((part) => BigInt(part!));
  for (const width of [1, 2]) {
    const name = `v${parts.slice(0, width).join(".")}`;
    const newer = [...tags.keys()].some((ref) => {
      const match = stable.exec(ref.replace(/^refs\/tags\//, ""));
      if (!match) return false;
      const other = match.slice(1).map((part) => BigInt(part!));
      if (!parts.slice(0, width).every((part, i) => part === other[i])) return false;
      return other.some(
        (part, i) => part > parts[i]! && other.slice(0, i).every((p, j) => p === parts[j]),
      );
    });
    if (newer) continue; // rerunning an older successful release must not roll aliases back
    const ref = `refs/tags/${name}`;
    const old = tags.get(ref) ?? "";
    if (old === target) continue;
    remote(["push", `--force-with-lease=${ref}:${old}`, "origin", `${target}:${ref}`]);
  }
}

try {
  rt.prepareOutputs();
  switch (process.argv[2]) {
    case "recover":
      recover();
      break;
    case "artifacts":
      artifacts();
      break;
    case "floating":
      floating();
      break;
    default:
      throw new Error("Expected recover, artifacts or floating.");
  }
} catch (error) {
  rt.error((error as Error).message);
  process.exitCode = 1;
}
