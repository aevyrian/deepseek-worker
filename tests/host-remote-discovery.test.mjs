import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Host discovery and Native processLease execute the imported Session runtime on the Loader context", async () => {
  const loader = new URL("./support/host-loader.mjs", import.meta.url).href;
  const probe = fileURLToPath(new URL("./support/host-remote-probe.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--no-warnings", "--experimental-loader", loader, probe], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0, `Host Remote discovery probe failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});
