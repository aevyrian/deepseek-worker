import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_DISABLED_SIGNATURE, migrateLegacyProfileArtifacts, planLegacyProfilePatch } from "../lib/profile-cleanup.mjs";

const connector = (config, extras = "") => `- id: deepseek-worker-connector\n${extras}  config:\n${config}`;
const legacy = LEGACY_DISABLED_SIGNATURE.map((id) => `- id: ${id}\n  disabled: true\n`).join("");

test("clean install does not change its single Connector patch", () => {
  const patch = connector("    endpoint: https://example.test/api/worker\n    updateChannel: stable\n");
  assert.deepEqual(planLegacyProfilePatch(patch), { content: patch, changed: false, removed: [], ambiguous: false });
});

test("clean profile creates no migration backup", async () => {
  const profile = await mkdtemp(join(tmpdir(), "deepseek-clean-profile-"));
  const patch = connector("    updateChannel: stable\n");
  await writeFile(join(profile, "cordis.patch.yml"), patch);
  const result = await migrateLegacyProfileArtifacts({ profile: { dir: profile } });
  assert.equal(result.patchChanged, false);
  assert.equal(result.linkRemoved, false);
  assert.deepEqual(await readdir(profile), ["cordis.patch.yml"]);
});

test("new profile without a patch file is left untouched", async () => {
  const profile = await mkdtemp(join(tmpdir(), "deepseek-empty-profile-"));
  const result = await migrateLegacyProfileArtifacts({ profile: { dir: profile } });
  assert.equal(result.patchChanged, false);
  assert.equal(result.linkRemoved, false);
  assert.deepEqual(await readdir(profile), []);
});

test("exact legacy disabled signature is removed without touching adjacent user rows", () => {
  const own = "- id: user-agent\n  disabled: true\n";
  const result = planLegacyProfilePatch(`${own}${legacy}${connector("    updateChannel: stable\n")}`);
  assert.equal(result.changed, true);
  assert.equal(result.content.startsWith(own), true);
  assert.equal(result.content.includes("preset-orchestrator-worker"), false);
  assert.equal(result.content.includes("- id: tool-fs\n"), false);
  assert.equal(result.content.includes("- id: deepseek-worker-connector"), true);
});

test("partial or edited legacy signature leaves shared disabled rows untouched", () => {
  const edited = legacy.replace("- id: tool-fs\n  disabled: true\n", "- id: tool-fs\n  disabled: false\n");
  const result = planLegacyProfilePatch(edited);
  assert.equal(result.changed, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.content, edited);
});

test("duplicate Connector rows merge while keeping effective user configuration", () => {
  const first = connector("    endpoint: https://example.test/api/worker\n    workerId: custom-worker\n    authorizedWorkspaceIds:\n      - workspace-a\n    trustedWorkspaceMode: true\n    pollIntervalMs: 4000\n    heartbeatIntervalMs: 20000\n    leaseRenewIntervalMs: 20000\n    leaseWaitTimeoutMs: 1800000\n    autoUpdate: true\n    updateChannel: preview\n", "  name: deepseek-worker-connector\n");
  const last = connector("    endpoint: https://example.test/api/worker\n    workerId: custom-worker\n    authorizedWorkspaceIds:\n      - workspace-a\n    trustedWorkspaceMode: true\n    updateChannel: stable\n", "  disabled: false\n");
  const result = planLegacyProfilePatch(`${first}${last}`);
  assert.equal(result.changed, true);
  assert.equal((result.content.match(/^- id: deepseek-worker-connector$/gm) || []).length, 1);
  assert.match(result.content, /name: deepseek-worker-connector/);
  assert.match(result.content, /disabled: false/);
  assert.match(result.content, /authorizedWorkspaceIds:\n      - workspace-a/);
  assert.match(result.content, /pollIntervalMs: 4000/);
  assert.match(result.content, /heartbeatIntervalMs: 20000/);
  assert.match(result.content, /leaseRenewIntervalMs: 20000/);
  assert.match(result.content, /leaseWaitTimeoutMs: 1800000/);
  assert.match(result.content, /autoUpdate: true/);
  assert.match(result.content, /updateChannel: stable/);
  assert.doesNotMatch(result.content, /updateChannel: preview/);
  assert.equal(planLegacyProfilePatch(result.content).changed, false);
});

test("profile migration leaves Credentials and Workspace data untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-profile-cleanup-"));
  const profile = join(root, "profile");
  await mkdir(profile);
  const patch = `${legacy}${connector("    authorizedWorkspaceIds:\n      - workspace-a\n    updateChannel: stable\n")}`;
  await writeFile(join(profile, "cordis.patch.yml"), patch);
  await writeFile(join(profile, "credentials.yaml"), "LOCAL_WORKER_TOKEN: dummy-private-value\n");
  const result = await migrateLegacyProfileArtifacts({ profile: { dir: profile } });
  assert.equal(result.status, "clean");
  assert.equal(result.patchChanged, true);
  assert.match(await readFile(join(profile, "cordis.patch.yml"), "utf8"), /workspace-a/);
  assert.match(await readFile(join(profile, "cordis.patch.yml"), "utf8"), /updateChannel: stable/);
  assert.equal(await readFile(join(profile, "credentials.yaml"), "utf8"), "LOCAL_WORKER_TOKEN: dummy-private-value\n");
  assert.equal((await readdir(profile)).some((name) => name.startsWith("cordis.patch.yml.deepseek-worker-") && name.endsWith(".bak")), true);
});

test("verified legacy junction is unlinked and two-file source is retired without deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-junction-cleanup-"));
  const profile = join(root, "profile"), source = join(root, "orchestrator-worker-preset");
  const local = join(profile, "node_modules", "@local");
  await mkdir(local, { recursive: true });
  await mkdir(source);
  await writeFile(join(profile, "cordis.patch.yml"), connector("    updateChannel: stable\n"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@local/dsh-orchestrator-worker-preset", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
  await writeFile(join(source, "cordis.patch.yml"), "- id: preset-orchestrator-worker\n  config:\n    id: orchestrator-worker\n");
  await symlink(source, join(local, "dsh-orchestrator-worker-preset"), "junction");
  const result = await migrateLegacyProfileArtifacts({ profile: { dir: profile } });
  assert.equal(result.linkRemoved, true);
  assert.equal(result.sourceRetired, true);
  assert.equal((await readdir(local)).length, 0);
  assert.equal((await readdir(`${source}.retired-deepseek-worker-0.4.8`)).length, 2);
});

test("source containing unrelated files is preserved with its junction", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-foreign-source-"));
  const profile = join(root, "profile"), source = join(root, "orchestrator-worker-preset");
  const local = join(profile, "node_modules", "@local");
  await mkdir(local, { recursive: true });
  await mkdir(source);
  await writeFile(join(profile, "cordis.patch.yml"), connector("    updateChannel: stable\n"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@local/dsh-orchestrator-worker-preset", dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
  await writeFile(join(source, "cordis.patch.yml"), "- id: preset-orchestrator-worker\n  config:\n    id: orchestrator-worker\n");
  await writeFile(join(source, "user-notes.txt"), "keep me");
  const link = join(local, "dsh-orchestrator-worker-preset");
  await symlink(source, link, "junction");
  const result = await migrateLegacyProfileArtifacts({ profile: { dir: profile } });
  assert.equal(result.linkRemoved, false);
  assert.equal(result.sourceRetired, false);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(join(source, "user-notes.txt"), "utf8"), "keep me");
});

test("broken exact legacy junction is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-broken-junction-"));
  const profile = join(root, "profile"), source = join(root, "orchestrator-worker-preset");
  const local = join(profile, "node_modules", "@local");
  await mkdir(local, { recursive: true });
  await writeFile(join(profile, "cordis.patch.yml"), connector("    updateChannel: stable\n"));
  const link = join(local, "dsh-orchestrator-worker-preset");
  await symlink(source, link, "junction");
  const result = await migrateLegacyProfileArtifacts({ profile: { dir: profile } });
  assert.equal(result.linkRemoved, true);
  assert.equal(result.sourceRetired, false);
  assert.deepEqual(await readdir(local), []);
});
