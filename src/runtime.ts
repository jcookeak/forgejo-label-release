import * as fs from "node:fs";
import * as os from "node:os";

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

  setOutput(name: string, value: string): void {
    const path = process.env["GITHUB_OUTPUT"];
    if (!path) {
      this.info(`::set-output name=${name}::${value}`);
      return;
    }
    const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(path, `${name}<<${delim}${os.EOL}${value}${os.EOL}${delim}${os.EOL}`);
  }

  info(msg: string): void {
    process.stdout.write(`${msg}${os.EOL}`);
  }

  warn(msg: string): void {
    process.stdout.write(`::warning::${msg}${os.EOL}`);
  }

  error(msg: string): void {
    process.stdout.write(`::error::${msg}${os.EOL}`);
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
