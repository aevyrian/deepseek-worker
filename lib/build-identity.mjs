import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function packageFiles(root) {
  const files = ["package.json", "index.js", "client.js"];
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) files.push(relative);
    }
  };
  visit("lib");
  return files.sort();
}

// Computed once while this module is loaded. Later on-disk edits therefore do
// not silently change the identity reported by an already-running process.
export function createBuildFingerprint(root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const packageRoot = resolve(root);
  const hash = createHash("sha256");
  for (const relativePath of packageFiles(packageRoot)) {
    const bytes = readFileSync(join(packageRoot, relativePath));
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const CONNECTOR_BUILD_HASH = createBuildFingerprint();
