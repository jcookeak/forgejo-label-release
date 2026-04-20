import { describe, expect, it } from "vitest";
import {
  applyBump,
  compareSemver,
  decideBump,
  formatSemver,
  parseSemver,
  pickLatest,
} from "../src/semver.ts";

describe("parseSemver", () => {
  it("strips the prefix", () => {
    expect(parseSemver("v1.2.3", "v")).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  it("returns null for non-semver", () => {
    expect(parseSemver("release-2024", "v")).toBeNull();
  });
  it("parses prerelease + build", () => {
    expect(parseSemver("v1.2.3-rc.1+abc", "v")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "rc.1",
      build: "abc",
    });
  });
});

describe("applyBump", () => {
  const base = { major: 1, minor: 2, patch: 3 };
  it("bumps major and resets minor/patch", () => {
    expect(applyBump(base, "major")).toEqual({ major: 2, minor: 0, patch: 0 });
  });
  it("bumps minor and resets patch", () => {
    expect(applyBump(base, "minor")).toEqual({ major: 1, minor: 3, patch: 0 });
  });
  it("bumps patch", () => {
    expect(applyBump(base, "patch")).toEqual({ major: 1, minor: 2, patch: 4 });
  });
});

describe("decideBump", () => {
  const cfg = { major: ["breaking"], minor: ["feature"], patch: ["bug"] };
  it("returns null when no labels match", () => {
    expect(decideBump(["chore", "docs"], cfg)).toBeNull();
  });
  it("picks major over minor/patch", () => {
    expect(decideBump(["bug", "feature", "breaking"], cfg)).toBe("major");
  });
  it("picks minor over patch", () => {
    expect(decideBump(["bug", "feature"], cfg)).toBe("minor");
  });
  it("matches case-insensitively", () => {
    expect(decideBump(["BREAKING"], cfg)).toBe("major");
  });
  it("ignores empty label sets", () => {
    expect(decideBump(["breaking"], { major: [], minor: [], patch: [] })).toBeNull();
  });
});

describe("pickLatest", () => {
  it("picks the highest non-prerelease tag", () => {
    const result = pickLatest(["v1.0.0", "v1.2.0", "v1.2.0-rc.1", "other"], "v");
    expect(result?.tag).toBe("v1.2.0");
  });
  it("returns null if nothing matches", () => {
    expect(pickLatest(["release-1", "foo"], "v")).toBeNull();
  });
});

describe("compareSemver + formatSemver", () => {
  it("round-trips", () => {
    const v = parseSemver("v2.0.0", "v")!;
    expect(formatSemver(v, "v")).toBe("v2.0.0");
  });
  it("orders prerelease before release", () => {
    const pre = parseSemver("1.0.0-rc.1", "")!;
    const rel = parseSemver("1.0.0", "")!;
    expect(compareSemver(pre, rel)).toBeLessThan(0);
  });
});
