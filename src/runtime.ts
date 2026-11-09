import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

function escapeCommandData(message: string): string {
  // Escape percent first so literal escape sequences survive the runner's decoding.
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export interface Runtime {
  getInput(name: string): string | undefined;
  getEnv(name: string): string | undefined;
  setOutput(name: string, value: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  readFile(path: string): string | undefined;
}

export class ActionRuntime implements Runtime {
  getInput(name: string): string | undefined {
    const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    const raw = process.env[key];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  getEnv(name: string): string | undefined {
    const v = process.env[name];
    return v === undefined || v === "" ? undefined : v;
  }

  private outputPath(): string {
    const path = process.env["GITHUB_OUTPUT"] || process.env["FORGEJO_OUTPUT"];
    if (!path) {
      throw new Error("Setting outputs requires GITHUB_OUTPUT or FORGEJO_OUTPUT.");
    }
    return path;
  }

  prepareOutputs(): void {
    // Check runner configuration before any remote publication can occur.
    fs.appendFileSync(this.outputPath(), "");
  }

  setOutput(name: string, value: string): void {
    const path = this.outputPath();
    if (!name || /[\r\n=]|<</.test(name)) {
      throw new Error("Invalid output name: must not be empty or contain CR, LF, '=' or '<<'.");
    }
    // Keep values verbatim; choose framing that cannot terminate inside the data.
    for (let attempt = 0; attempt < 10; attempt++) {
      const delim = `ghadelim_${randomUUID()}`;
      if (name.includes(delim) || value.includes(delim)) continue;
      fs.appendFileSync(path, `${name}<<${delim}${os.EOL}${value}${os.EOL}${delim}${os.EOL}`);
      return;
    }
    throw new Error("Could not generate a collision-free output delimiter.");
  }

  info(msg: string): void {
    // Plain log text is not decoded command data: neutralize both command syntaxes.
    const text = msg.replace(/::/g, "%3A%3A").replace(/##\[/g, "%23%23[");
    process.stdout.write(`${text}${os.EOL}`);
  }

  warn(msg: string): void {
    process.stdout.write(`::warning::${escapeCommandData(msg)}${os.EOL}`);
  }

  error(msg: string): void {
    process.stdout.write(`::error::${escapeCommandData(msg)}${os.EOL}`);
  }

  readFile(path: string): string | undefined {
    try {
      return fs.readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
}
