import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { run } from "../src/main.ts";
import type { Runtime } from "../src/runtime.ts";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

interface MockState {
  latestRelease: unknown;
  tags: { name: string }[];
  compare: { commits: { sha: string; commit: { message: string } }[] };
  prs: Record<string, unknown>;
  created: RecordedRequest[];
}

function startMockServer(state: MockState): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const collect: Buffer[] = [];
    req.on("data", (c: Buffer) => collect.push(c));
    req.on("end", () => {
      const bodyRaw = Buffer.concat(collect).toString("utf8");
      const body = bodyRaw ? JSON.parse(bodyRaw) : undefined;
      const url = req.url ?? "";
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "GET" && url.endsWith("/releases/latest")) {
        if (state.latestRelease === null) return json(404, { message: "not found" });
        return json(200, state.latestRelease);
      }
      if (req.method === "GET" && url.includes("/tags")) return json(200, state.tags);
      if (req.method === "GET" && url.includes("/compare/")) return json(200, state.compare);
      const prMatch = /\/pulls\/(\d+)$/.exec(url);
      if (req.method === "GET" && prMatch) {
        const pr = state.prs[prMatch[1]!];
        if (!pr) return json(404, { message: "not found" });
        return json(200, pr);
      }
      if (req.method === "GET" && url.includes("/pulls?")) return json(200, []);
      if (req.method === "POST" && url.endsWith("/releases")) {
        state.created.push({ method: req.method, url, body });
        const asObj = body as { tag_name: string; target_commitish: string };
        return json(201, { id: 1, tag_name: asObj.tag_name, target_commitish: asObj.target_commitish });
      }

      json(404, { message: `unhandled ${req.method} ${url}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no address");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

class SmokeRuntime implements Runtime {
  outputs: Record<string, string> = {};
  constructor(
    private readonly inputs: Record<string, string>,
    private readonly env: Record<string, string>,
  ) {}
  getInput(n: string): string | undefined {
    const v = this.inputs[n];
    return v === undefined || v === "" ? undefined : v;
  }
  getEnv(n: string): string | undefined {
    const v = this.env[n];
    return v === undefined || v === "" ? undefined : v;
  }
  setOutput(n: string, v: string): void {
    this.outputs[n] = v;
  }
  info(m: string): void {
    process.stdout.write(`[smoke] ${m}\n`);
  }
  warn(m: string): void {
    process.stderr.write(`[smoke warn] ${m}\n`);
  }
  error(m: string): void {
    process.stderr.write(`[smoke error] ${m}\n`);
  }
  readFile(p: string): string | undefined {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  }
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "label-release-smoke-"));
  const templatePath = path.join(tmpDir, "release.yml");
  fs.writeFileSync(
    templatePath,
    `changelog:\n  categories:\n    - title: Features\n      labels: ["feature"]\n    - title: Fixes\n      labels: ["bug"]\n`,
  );

  const state: MockState = {
    latestRelease: { id: 1, tag_name: "v1.2.3", target_commitish: "oldsha" },
    tags: [{ name: "v1.2.3" }],
    compare: {
      commits: [
        { sha: "a", commit: { message: "Add endpoint (#10)" } },
        { sha: "b", commit: { message: "Fix typo (#11)" } },
      ],
    },
    prs: {
      "10": {
        number: 10,
        title: "Add endpoint",
        html_url: "http://x/10",
        user: { login: "alice" },
        labels: [{ name: "feature" }],
        merge_commit_sha: "a",
        merged: true,
      },
      "11": {
        number: 11,
        title: "Fix typo",
        html_url: "http://x/11",
        user: { login: "bob" },
        labels: [{ name: "bug" }],
        merge_commit_sha: "b",
        merged: true,
      },
    },
    created: [],
  };

  const server = await startMockServer(state);
  try {
    const rt = new SmokeRuntime(
      {
        "release-template": templatePath,
        "major-labels": "breaking",
        "minor-labels": "feature",
        "patch-labels": "bug",
      },
      {
        GITHUB_TOKEN: "smoke-token",
        GITHUB_SERVER_URL: server.url,
        GITHUB_REPOSITORY: "acme/widgets",
        GITHUB_SHA: "headsha",
      },
    );
    await run(rt);

    assert(rt.outputs["released"] === "true", `expected released=true, got ${rt.outputs["released"]}`);
    assert(rt.outputs["bump"] === "minor", `expected bump=minor, got ${rt.outputs["bump"]}`);
    assert(rt.outputs["tag"] === "v1.3.0", `expected tag=v1.3.0, got ${rt.outputs["tag"]}`);
    assert(rt.outputs["previous-tag"] === "v1.2.3", `expected previous-tag=v1.2.3`);
    assert(state.created.length === 1, `expected 1 release creation, got ${state.created.length}`);
    const body = state.created[0]!.body as { tag_name: string; body: string };
    assert(body.tag_name === "v1.3.0", `created tag mismatch`);
    assert(body.body.includes("### Features"), `notes missing Features section`);
    assert(body.body.includes("#10"), `notes missing PR #10`);
    assert(body.body.includes("### Fixes"), `notes missing Fixes section`);

    process.stdout.write("smoke test passed\n");
  } finally {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
}

main().catch((err: unknown) => {
  const m = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${m}\n`);
  process.exit(1);
});
