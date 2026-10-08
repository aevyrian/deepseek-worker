import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_FILES = Object.freeze([
  "package.json",
  "index.js",
  "lib/build-identity.mjs",
  "lib/bridge-outbox.mjs",
  "lib/chat-bridge.mjs",
  "lib/task-pool.mjs",
  "lib/update.mjs",
  "lib/wake-transport.mjs",
]);

// Computed once while this module is loaded. Later on-disk edits therefore do
// not silently change the identity reported by an already-running process.
export function createBuildFingerprint(root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const packageRoot = resolve(root);
  const hash = createHash("sha256");
  for (const relativePath of PACKAGE_FILES) {
    const bytes = readFileSync(join(packageRoot, relativePath));
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const CONNECTOR_BUILD_HASH = createBuildFingerprint();
