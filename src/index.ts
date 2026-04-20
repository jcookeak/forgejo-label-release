import { run } from "./main.js";
import { ActionRuntime } from "./runtime.js";

const runtime = new ActionRuntime();

run(runtime).catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  runtime.error(msg);
  process.exit(1);
});
