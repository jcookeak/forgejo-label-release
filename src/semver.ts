import type { BumpKind, SemVer } from "./types.ts";

const SEMVER_RE =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?$/;

export function parseSemver(tag: string, prefix: string): SemVer | null {
  const stripped = tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  const m = SEMVER_RE.exec(stripped);
  if (!m || !m.groups) return null;
  const g = m.groups;
  return {
    major: Number(g["major"]),
    minor: Number(g["minor"]),
    patch: Number(g["patch"]),
    prerelease: g["prerelease"],
    build: g["build"],
  };
}

export function formatSemver(v: SemVer, prefix: string): string {
  let out = `${prefix}${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease) out += `-${v.prerelease}`;
  if (v.build) out += `+${v.build}`;
  return out;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
  }
  return 0;
}

export function applyBump(v: SemVer, kind: BumpKind): SemVer {
  switch (kind) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

export interface LabelConfig {
  major: string[];
  minor: string[];
  patch: string[];
}

function matches(labels: Iterable<string>, set: string[]): boolean {
  if (set.length === 0) return false;
  const lc = new Set(Array.from(labels, (l) => l.toLowerCase()));
  return set.some((s) => lc.has(s.toLowerCase()));
}

export function decideBump(allLabels: Iterable<string>, cfg: LabelConfig): BumpKind | null {
  const labels = Array.from(allLabels);
  if (matches(labels, cfg.major)) return "major";
  if (matches(labels, cfg.minor)) return "minor";
  if (matches(labels, cfg.patch)) return "patch";
  return null;
}

export function pickLatest(
  tags: string[],
  prefix: string,
): { tag: string; version: SemVer } | null {
  let best: { tag: string; version: SemVer } | null = null;
  for (const tag of tags) {
    const v = parseSemver(tag, prefix);
    if (!v) continue;
    if (v.prerelease) continue;
    if (!best || compareSemver(v, best.version) > 0) best = { tag, version: v };
  }
  return best;
}
