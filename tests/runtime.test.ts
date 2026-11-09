import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgejoApiError } from "../src/forgejo.ts";
import { run } from "../src/main.js";
import { ActionRuntime } from "../src/runtime.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});
vi.mock("../src/main.js", () => ({ run: vi.fn() }));

function captureStdout() {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => write.mock.calls.map(([chunk]) => String(chunk)).join("");
}

beforeEach(() => {
  vi.mocked(run).mockReset();
  vi.stubEnv("GITHUB_OUTPUT", "");
  vi.stubEnv("FORGEJO_OUTPUT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(randomUUID).mockReset();
});

describe("ActionRuntime logging", () => {
  it.each(["warn", "error"] as const)("escapes command data in %s annotations", (method) => {
    const stdout = captureStdout();
    const runtime = new ActionRuntime();
    const message =
      "API response 100% %0A\r\n::warning::forged\n::set-output name=notes::forged\r##[error]forged";

    runtime[method](message);

    const command = method === "warn" ? "warning" : "error";
    expect(stdout()).toBe(
      `::${command}::API response 100%25 %250A%0D%0A::warning::forged%0A::set-output name=notes::forged%0D##[error]forged${EOL}`,
    );
    expect(stdout().split(EOL)).toHaveLength(2);
  });

  it("keeps ordinary info text and multiline formatting", () => {
    const stdout = captureStdout();
    new ActionRuntime().info("Found 1 PR(s).\nProgress: 100%\r\nDone.");
    expect(stdout()).toBe(`Found 1 PR(s).\nProgress: 100%\r\nDone.${EOL}`);
  });

  it("neutralizes modern and legacy command markers anywhere in info text", () => {
    const stdout = captureStdout();
    new ActionRuntime().info(
      "prefix ::warning::untrusted\n::set-output name=notes::forged\r##[error]forged",
    );
    expect(stdout()).toBe(
      `prefix %3A%3Awarning%3A%3Auntrusted\n%3A%3Aset-output name=notes%3A%3Aforged\r%23%23[error]forged${EOL}`,
    );
    expect(stdout()).not.toContain("::");
    expect(stdout()).not.toContain("##[");
  });

  it("contains an entrypoint API error stack within one error annotation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "label-release-entrypoint-"));
    vi.stubEnv("GITHUB_OUTPUT", join(directory, "output"));
    const stdout = captureStdout();
    const error = new ForgejoApiError(
      "create release",
      500,
      "Internal Server Error",
      "untrusted %0A\r\n::warning::forged\n::set-output name=notes::forged",
    );
    error.stack = `${error.name}: ${error.message}\n    at remoteCall (action.js:1:1)`;
    vi.mocked(run).mockRejectedValueOnce(error);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    vi.resetModules();
    await import("../src/index.ts");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
    rmSync(directory, { recursive: true, force: true });

    expect(stdout()).toContain("untrusted %250A%0D%0A::warning::forged%0A::set-output");
    expect(stdout()).toContain("%0A    at remoteCall (action.js:1:1)");
    expect(stdout().startsWith("::error::")).toBe(true);
    expect(stdout().split(EOL)).toHaveLength(2);
  });
});

describe("entrypoint output preflight", () => {
  it("fails before running release logic when output configuration is missing", async () => {
    const stdout = captureStdout();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.resetModules();
    await import("../src/index.ts");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
    expect(run).not.toHaveBeenCalled();
    expect(stdout()).toContain("GITHUB_OUTPUT or FORGEJO_OUTPUT");
  });
});

describe("ActionRuntime output files", () => {
  let directory: string;
  let outputPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "label-release-runtime-"));
    outputPath = join(directory, "output");
    writeFileSync(outputPath, "");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("checks output writability without changing existing output data", () => {
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    writeFileSync(outputPath, "existing=value\n");
    new ActionRuntime().prepareOutputs();
    expect(readFileSync(outputPath, "utf8")).toBe("existing=value\n");
    vi.stubEnv("GITHUB_OUTPUT", join(directory, "missing", "output"));
    expect(() => new ActionRuntime().prepareOutputs()).toThrow();
  });

  it.each(["GITHUB_OUTPUT", "FORGEJO_OUTPUT"])("supports %s without stdout commands", (env) => {
    const stdout = captureStdout();
    vi.stubEnv(env, outputPath);
    new ActionRuntime().setOutput("released", "true");
    const file = readFileSync(outputPath, "utf8");
    expect(file).toMatch(
      /^released<<ghadelim_[0-9a-f-]{36}\r?\ntrue\r?\nghadelim_[0-9a-f-]{36}\r?\n$/,
    );
    const delimiter = file.slice("released<<".length, file.indexOf(EOL));
    expect(file).toBe(`released<<${delimiter}${EOL}true${EOL}${delimiter}${EOL}`);
    expect(stdout()).toBe("");
  });

  it("prefers GITHUB_OUTPUT when both aliases are present", () => {
    const forgejoPath = join(directory, "forgejo-output");
    writeFileSync(forgejoPath, "");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    vi.stubEnv("FORGEJO_OUTPUT", forgejoPath);
    new ActionRuntime().setOutput("released", "false");
    expect(readFileSync(outputPath, "utf8")).toContain(`${EOL}false${EOL}`);
    expect(readFileSync(forgejoPath, "utf8")).toBe("");
  });

  it.each([undefined, ""])("fails closed with missing output paths (%s)", (value) => {
    const stdout = captureStdout();
    vi.stubEnv("GITHUB_OUTPUT", value);
    vi.stubEnv("FORGEJO_OUTPUT", value);
    expect(() => new ActionRuntime().setOutput("notes", "\n::warning::forged")).toThrow(
      "GITHUB_OUTPUT or FORGEJO_OUTPUT",
    );
    expect(stdout()).toBe("");
    expect(readFileSync(outputPath, "utf8")).toBe("");
  });

  it("does not fall back to stdout or the other alias after a file error", () => {
    const stdout = captureStdout();
    vi.stubEnv("GITHUB_OUTPUT", join(directory, "missing", "output"));
    vi.stubEnv("FORGEJO_OUTPUT", outputPath);
    expect(() => new ActionRuntime().setOutput("released", "true")).toThrow();
    expect(stdout()).toBe("");
    expect(readFileSync(outputPath, "utf8")).toBe("");
  });

  it.each([
    "",
    "## Notes\n\n100% %0A\r\n::warning::text\n::set-output name=x::text\r",
    "notes\n\n",
  ])("preserves output contents verbatim: %j", (value) => {
    const stdout = captureStdout();
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    new ActionRuntime().setOutput("notes", value);
    const file = readFileSync(outputPath, "utf8");
    const delimiter = file.slice("notes<<".length, file.indexOf(EOL));
    expect(delimiter).toMatch(/^ghadelim_[0-9a-f-]{36}$/);
    expect(file).toBe(`notes<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
    expect(stdout()).toBe("");
  });

  it("appends multiple outputs without overwriting existing contents", () => {
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const runtime = new ActionRuntime();
    runtime.setOutput("tag", "v1.2.3");
    const first = readFileSync(outputPath, "utf8");
    runtime.setOutput("notes", "line 1\nline 2");
    const file = readFileSync(outputPath, "utf8");
    expect(file.startsWith(first)).toBe(true);
    expect(file.slice(first.length)).toMatch(/^notes<<ghadelim_/);
    expect(file).toContain(`line 1\nline 2${EOL}`);
  });

  it.each(["name", "value"] as const)("regenerates a delimiter found in the %s", (field) => {
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    vi.mocked(randomUUID).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const name = field === "name" ? `ghadelim_${first}` : "notes";
    const value = field === "value" ? `before\nghadelim_${first}\nafter` : "notes";

    new ActionRuntime().setOutput(name, value);

    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${name}<<ghadelim_${second}${EOL}${value}${EOL}ghadelim_${second}${EOL}`,
    );
  });

  it("fails closed if a collision-free delimiter cannot be generated", () => {
    const stdout = captureStdout();
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const uuid = "00000000-0000-4000-8000-000000000001";
    vi.mocked(randomUUID).mockReturnValue(uuid);
    expect(() => new ActionRuntime().setOutput("notes", `ghadelim_${uuid}`)).toThrow(
      "output delimiter",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("");
    expect(stdout()).toBe("");
  });

  it.each(["", "notes\nforged", "notes\rforged", "notes=forged", "notes<<forged"])(
    "rejects a name that would break output-file framing: %j",
    (name) => {
      const stdout = captureStdout();
      vi.stubEnv("GITHUB_OUTPUT", outputPath);
      expect(() => new ActionRuntime().setOutput(name, "value")).toThrow("output name");
      expect(readFileSync(outputPath, "utf8")).toBe("");
      expect(stdout()).toBe("");
    },
  );
});
