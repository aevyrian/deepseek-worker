import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTOR_PACKAGE,
  CONNECTOR_VERSION,
  TRUSTED_SOURCE,
  UPDATE_CHECK_INTERVAL_MS,
  buildInstallSpec,
  classifyInstallSource,
  compareSemver,
  createUpdateRuntime,
  installedSourceError,
  isNewerVersion,
  isTrustedSource,
  officialMigrationGuidance,
  parseSemver,
  performUpdateCheck,
  performUpdateInstall,
  publicUpdateStatus,
  readRecordedInstallSpec,
  resolveInstalledSourceEvidence,
  resolveUpdateCandidate,
  selectUpdateCandidate,
  validateUpdateManifest,
} from "../lib/update.mjs";

const temporaryProfileDirs = [];

after(async () => {
  await Promise.all(temporaryProfileDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Build a real profile directory whose package.json records one install spec, so tests exercise the
 * same file-reading path production uses instead of stubbing the reader.
 * @param spec Recorded dependency spec, or null to record no entry at all.
 * @returns Harness-like profile context.
 */
async function recordedProfileContext(spec) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-connector-profile-"));
  temporaryProfileDirs.push(dir);
  const manifest = { name: "dsh-profile-test", private: true, dependencies: {} };
  if (typeof spec === "string") manifest.dependencies[CONNECTOR_PACKAGE] = spec;
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
  return Object.freeze({ name: "test", dir, installAnchor: join(dir, "package.json") });
}

// The trusted GitHub form the Harness Plugin Manager records after one official install.
const TRUSTED_PROFILE = await recordedProfileContext("github:aevyrian/deepseek-worker");

function response(body, status = 200) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function manifest(version = "0.3.2", overrides = {}) {
  return {
    version,
    channel: version.includes("-") ? "preview" : "stable",
    source: TRUSTED_SOURCE,
    ref: `v${version}`,
    mandatory: false,
    notes: "",
    ...overrides,
  };
}

function cloudOnly(value, {
  tagSha = "a".repeat(40),
  packageVersion = value?.version,
  packageName = CONNECTOR_PACKAGE,
  bundlePatch = "./dsh.bundle.patch.yml",
} = {}) {
  return async (url) => {
    const href = String(url);
    if (href.endsWith("/api/connector/latest")) return response(value);
    if (href.includes("/git/ref/tags/")) {
      return response({
        ref: `refs/tags/${value.ref}`,
        object: { type: "commit", sha: tagSha },
      });
    }
    if (href.startsWith("https://raw.githubusercontent.com/aevyrian/deepseek-worker/")) {
      return response({
        name: packageName,
        version: packageVersion,
        dsh: { bundle: { patch: bundlePatch } },
      });
    }
    throw new Error(`unexpected URL: ${href}`);
  };
}

function githubFallback({ releases = [], tags = [] } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.endsWith("/api/connector/latest")) return response({ error: "not found" }, 404);
    if (href.includes("/releases?")) return response(releases);
    if (href.includes("/tags?")) return response(tags);
    throw new Error(`unexpected URL: ${href}`);
  };
}

/**
 * Fake Harness Plugin Manager.
 *
 * The bundle record deliberately mirrors the real `BundleInfo` shape that
 * `@deepseek-ai/dsh-plugin-manager` returns from `listBundles()`: name, version, enabled, installed,
 * optional, removable, rows and overrides. Real Harness does NOT publish a `source` field, so this
 * double must not invent one; the install source is read from the profile manifest instead.
 * `bundleSource` exists only to simulate a future Harness that starts reporting one.
 */
function pluginManager({
  bundleSource,
  bundleInstalled = true,
  profile,
  bundles,
  result = {
    changed: true,
    application: "restart-required",
    stage: "install",
    target: TRUSTED_SOURCE,
    bundle: CONNECTOR_PACKAGE,
    version: "0.8.0",
  },
  onInstall,
} = {}) {
  return {
    ...(profile ? { profile } : {}),
    async listBundles() {
      if (Array.isArray(bundles)) return bundles;
      return [{
        name: CONNECTOR_PACKAGE,
        version: CONNECTOR_VERSION,
        enabled: true,
        installed: bundleInstalled,
        optional: false,
        removable: true,
        rows: [],
        overrides: [],
        ...(bundleSource === undefined ? {} : { source: bundleSource }),
      }];
    },
    async installBundle(spec, options) {
      onInstall?.(spec, options);
      return result;
    },
  };
}

test("updater current version stays synchronized with package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, CONNECTOR_VERSION);
});

test("update status distinguishes running and installed versions", () => {
  const runtime = createUpdateRuntime("0.3.3-preview.6");
  runtime.installedVersion = "0.4.8";
  runtime.latestVersion = "0.4.8";
  runtime.updateState = "restart-required";
  runtime.restartRequired = true;
  assert.deepEqual(publicUpdateStatus(runtime), {
    currentVersion: "0.3.3-preview.6",
    installedVersion: "0.4.8",
    installedSource: null,
    latestVersion: "0.4.8",
    updateState: "restart-required",
    updateSource: null,
    lastCheckedAt: null,
    restartRequired: true,
    lastUpdateError: null,
    lastUpdateErrorCode: null,
  });
});

test("Semantic Version comparison follows SemVer precedence", () => {
  assert.ok(parseSemver("0.3.1"));
  assert.ok(parseSemver("0.3.2-preview.1"));
  assert.equal(parseSemver("0.03.1"), null);
  assert.equal(compareSemver("0.3.2", "0.3.1"), 1);
  assert.equal(compareSemver("0.3.1", "0.3.1+build.5"), 0);
  assert.equal(compareSemver("0.3.2-preview.2", "0.3.2-preview.10"), -1);
  assert.equal(compareSemver("0.3.2-preview.1", "0.3.2"), -1);
  assert.equal(
    compareSemver("999999999999999999999999.0.0", "999999999999999999999998.999999999999999999999999.999999999999999999999999"),
    1,
  );
  assert.equal(
    compareSemver("0.3.2-preview.999999999999999999999999", "0.3.2-preview.999999999999999999999998"),
    1,
  );
  assert.equal(isNewerVersion("0.3.2", "0.3.1"), true);
  assert.equal(isNewerVersion("0.3.0", "0.3.1"), false);
});

test("no new version returns no update", () => {
  assert.equal(selectUpdateCandidate([manifest("0.3.1")], "0.3.1", "stable"), null);
});

test("discovers a newer stable version", () => {
  const selected = selectUpdateCandidate([manifest("0.3.2")], "0.3.1", "stable");
  assert.equal(selected.version, "0.3.2");
  assert.equal(selected.channel, "stable");
});

test("stable channel ignores preview releases", () => {
  assert.equal(
    selectUpdateCandidate([manifest("0.3.2-preview.1")], "0.3.1", "stable"),
    null,
  );
});

test("preview channel can receive preview releases", () => {
  const selected = selectUpdateCandidate([manifest("0.3.2-preview.1")], "0.3.1", "preview");
  assert.equal(selected.version, "0.3.2-preview.1");
  assert.equal(selected.channel, "preview");
});

test("illegal semantic versions are rejected", () => {
  assert.throws(
    () => validateUpdateManifest(manifest("not-semver", { ref: "vnot-semver" })),
    /Semantic Version/,
  );
});

test("downgrades and same-version candidates are skipped", () => {
  assert.equal(selectUpdateCandidate([manifest("0.3.0")], "0.3.1", "stable"), null);
  assert.equal(selectUpdateCandidate([manifest("0.3.1")], "0.3.1", "stable"), null);
});

test("trusted installed Git source forms are accepted but arbitrary hosts are not", () => {
  assert.equal(isTrustedSource(TRUSTED_SOURCE), true);
  assert.equal(isTrustedSource("github:aevyrian/deepseek-worker#v0.3.1"), true);
  assert.equal(isTrustedSource("git+https://github.com/aevyrian/deepseek-worker.git#v0.3.1"), true);
  assert.equal(isTrustedSource("https://example.com/aevyrian/deepseek-worker.git"), false);
});

test("official profile install evidence accepts Harness git spec spellings and hides untrusted values", async () => {
  for (const spec of [
    "github:aevyrian/deepseek-worker#v0.7.11",
    "git+https://github.com/aevyrian/deepseek-worker.git#v0.7.11",
    "https://github.com/aevyrian/deepseek-worker.git#0123456789abcdef0123456789abcdef01234567",
  ]) {
    const evidence = await resolveInstalledSourceEvidence({ profileContext: await recordedProfileContext(spec) });
    assert.equal(evidence.status, "trusted", spec);
    assert.equal(evidence.display, `GitHub ${"aevyrian/deepseek-worker"}`);
  }

  const untrusted = await resolveInstalledSourceEvidence({
    profileContext: await recordedProfileContext("https://user:secret@example.com/private/repo.git"),
  });
  assert.equal(untrusted.status, "untrusted");
  assert.equal(untrusted.spec, null);
  assert.equal(untrusted.display, "Unrecognized source");
  assert.doesNotMatch(installedSourceError(untrusted, "0.7.12").message, /secret|example\.com/);
});

test("missing install source gives a one-time official Plugin Manager migration instruction", () => {
  const error = installedSourceError({ status: "absent" }, "0.7.12");
  assert.equal(error.code, "installed-source-unknown");
  assert.match(error.message, /Harness 官方 Plugin Manager/);
  assert.match(error.message, /https:\/\/github\.com\/aevyrian\/deepseek-worker\.git#v0\.7\.12/);
});

test("manifest source cannot carry its own branch or ref", () => {
  assert.throws(
    () => validateUpdateManifest(manifest("0.3.2", {
      source: `${TRUSTED_SOURCE}#main`,
    })),
    /非规范化仓库地址/,
  );
});

test("wrong repository source is rejected", () => {
  assert.equal(isTrustedSource("https://github.com/attacker/deepseek-worker.git"), false);
  assert.throws(
    () => validateUpdateManifest(manifest("0.3.2", {
      source: "https://github.com/attacker/deepseek-worker.git",
    })),
    /受信任/,
  );
});

test("manifest cannot smuggle shell or command fields", () => {
  assert.throws(
    () => validateUpdateManifest({ ...manifest("0.3.2"), command: "powershell.exe" }),
    /不允许的字段/,
  );
  assert.throws(
    () => validateUpdateManifest({ ...manifest("0.3.2"), script: "rm -rf" }),
    /不允许的字段/,
  );
});

test("exact update ref accepts version tag or commit SHA, never main", () => {
  assert.equal(buildInstallSpec(manifest("0.3.2")), `${TRUSTED_SOURCE}#v0.3.2`);
  assert.match(
    buildInstallSpec(manifest("0.3.2", { ref: "0123456789abcdef0123456789abcdef01234567" })),
    /#0123456789abcdef0123456789abcdef01234567$/,
  );
  assert.throws(() => buildInstallSpec(manifest("0.3.2", { ref: "main" })), /正式 tag 或精确 commit SHA/);
});

test("Cloud manifest absence falls back to an exact GitHub stable tag", async () => {
  const selected = await resolveUpdateCandidate({
    currentVersion: "0.3.1",
    channel: "stable",
    fetchImpl: githubFallback({
      tags: [
        { name: "v0.3.2", commit: { sha: "a".repeat(40) } },
        { name: "v0.3.1", commit: { sha: "b".repeat(40) } },
      ],
    }),
  });
  assert.equal(selected.version, "0.3.2");
  assert.equal(selected.ref, "v0.3.2");
});

test("a stale HTTP 200 Cloud manifest does not suppress a newer GitHub release", async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/api/connector/latest")) return response(manifest("0.6.0"));
    if (href.includes("/releases?")) return response([{ tag_name: "v0.7.9", draft: false, prerelease: false }]);
    if (href.includes("/tags?")) return response([{ name: "v0.7.9" }]);
    throw new Error(`unexpected URL: ${href}`);
  };
  const selected = await resolveUpdateCandidate({ currentVersion: "0.7.8", channel: "stable", fetchImpl });
  assert.equal(selected.version, "0.7.9");
  assert.equal(selected.ref, "v0.7.9");
});

test("stable GitHub fallback ignores prerelease while preview accepts it", async () => {
  const fetchImpl = githubFallback({
    releases: [
      { tag_name: "v0.3.2-preview.1", draft: false, prerelease: true, body: "preview" },
    ],
    tags: [{ name: "v0.3.2-preview.1" }],
  });
  assert.equal(await resolveUpdateCandidate({
    currentVersion: "0.3.1", channel: "stable", fetchImpl,
  }), null);
  const preview = await resolveUpdateCandidate({
    currentVersion: "0.3.1", channel: "preview", fetchImpl,
  });
  assert.equal(preview.version, "0.3.2-preview.1");
});

test("GitHub network failure leaves update discovery failed rather than guessing", async () => {
  await assert.rejects(
    () => resolveUpdateCandidate({
      currentVersion: "0.3.1",
      channel: "stable",
      fetchImpl: async () => { throw new Error("network down"); },
    }),
    /GitHub/,
  );
});

test("minimum Harness version rejects an incompatible runtime before install", async () => {
  let installCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { installCalls += 1; } }),
    harnessVersion: "0.4.0",
    fetchImpl: cloudOnly(manifest("0.8.0", { minimumHarnessVersion: "0.7.0" })),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /更高版本/);
  assert.equal(installCalls, 0);
});

test("untrusted recorded install source is refused before replacement", async () => {
  let installCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { installCalls += 1; } }),
    harnessVersion: "1.0.0",
    profileContext: await recordedProfileContext("file:C:/random/deepseek-worker"),
    fetchImpl: cloudOnly(manifest("0.8.0")),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /GitHub 安装源/);
  assert.equal(status.lastUpdateErrorCode, "installed-source-untrusted");
  assert.equal(installCalls, 0, "an untrusted recorded source must never be overwritten");
});

test("correct Git tag update uses official installBundle with enabled false", async () => {
  const calls = [];
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      onInstall: (spec, options) => calls.push({ spec, options }),
    }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
  });

  assert.equal(status.updateState, "restart-required");
  assert.equal(status.restartRequired, true);
  assert.equal(status.latestVersion, "0.8.0");
  assert.deepEqual(calls, [{
    spec: `${TRUSTED_SOURCE}#${"a".repeat(40)}`,
    options: { enabled: false },
  }]);
});

test("official Plugin Manager profile property supports sequential trusted updates", async () => {
  const calls = [];
  const runtime = createUpdateRuntime();
  const manager = pluginManager({
    profile: TRUSTED_PROFILE,
    result: { changed: true, application: "restart-required", bundle: CONNECTOR_PACKAGE },
    onInstall: (spec, options) => calls.push({ spec, options }),
  });
  for (const version of ["0.8.0", "0.9.0"]) {
    const status = await performUpdateInstall({
      runtime,
      config: { autoUpdate: true, updateChannel: "stable" },
      pluginManager: manager,
      harnessVersion: "1.0.0",
      fetchImpl: cloudOnly(manifest(version)),
    });
    assert.equal(status.updateState, "restart-required");
    assert.equal(status.installedSource, "GitHub aevyrian/deepseek-worker");
    // A successful Plugin Manager result requires an application restart before another update.
    // Resetting this flag models that restart without touching a real Harness instance.
    runtime.restartRequired = false;
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.spec.startsWith(`${TRUSTED_SOURCE}#`)));
  assert.ok(calls.every((call) => call.options.enabled === false));
});

test("package metadata mismatch is rejected before Plugin Manager replacement", async () => {
  let installCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { installCalls += 1; } }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0"), { packageVersion: "9.9.9" }),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /metadata/);
  assert.equal(installCalls, 0);
});

test("worker busy state becomes waiting-idle and update starts only after task completion", async () => {
  const states = [];
  let busy = true;
  let installedWhileBusy = null;
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      onInstall: () => { installedWhileBusy = busy; },
    }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
    isWorkerBusy: () => busy,
    sleepImpl: async () => {
      states.push(runtime.updateState);
      busy = false;
    },
  });

  assert.deepEqual(states, ["waiting-idle"]);
  assert.equal(installedWhileBusy, false);
  assert.equal(status.updateState, "restart-required");
});

test("Plugin Manager update failure keeps the current Connector runtime usable", async () => {
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      result: {
        changed: false,
        application: "failed",
        stage: "install",
        target: TRUSTED_SOURCE,
        error: { code: "operation-error" },
      },
    }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
  });
  assert.equal(status.currentVersion, CONNECTOR_VERSION);
  assert.equal(status.restartRequired, false);
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /当前 Connector 继续运行/);
});

test("bundle validation failure leaves the running Connector on the current version", async () => {
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      result: {
        changed: false,
        application: "failed",
        stage: "install",
        target: TRUSTED_SOURCE,
        error: { code: "bundle-invalid" },
      },
    }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
  });
  assert.equal(status.currentVersion, CONNECTOR_VERSION);
  assert.equal(status.restartRequired, false);
  assert.equal(status.updateState, "failed");
});

test("official incompatibility result is surfaced without replacing runtime state", async () => {
  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      result: {
        changed: false,
        application: "failed",
        stage: "install",
        target: TRUSTED_SOURCE,
        error: { code: "incompatible-version" },
      },
    }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /不兼容/);
  assert.equal(status.currentVersion, CONNECTOR_VERSION);
});

test("manual update check remains available when auto-update is disabled and never installs", async () => {
  let packageCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: false, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { packageCalls += 1; } }),
    harnessVersion: "1.0.0",
    fetchImpl: async (url) => String(url).endsWith("/api/connector/latest")
      ? response(manifest("0.6.0"))
      : String(url).includes("/releases?")
      ? response([{ tag_name: "v0.7.13", draft: false, prerelease: false }])
      : String(url).includes("/tags?")
        ? response([{ name: "v0.7.13" }])
          : response(null, 404),
  });
  assert.equal(status.updateState, "available");
  assert.equal(status.latestVersion, "0.7.13");
  assert.equal(status.updateSource, "github-releases");
  assert.ok(status.lastCheckedAt);
  assert.equal(packageCalls, 0, "checking updates must not call the Plugin Manager");
});

test("forced update queries GitHub and reinstalls the same stable version through Plugin Manager", async () => {
  const calls = [];
  const runtime = createUpdateRuntime();
  const sha = "c".repeat(40);
  const fetchImpl = async (url) => {
    const href = String(url);
    assert.ok(!href.endsWith("/api/connector/latest"), "forced install must use GitHub as its source");
    if (href.includes("/releases?")) return response([{ tag_name: `v${CONNECTOR_VERSION}`, draft: false, prerelease: false }]);
    if (href.includes("/tags?")) return response([{ name: `v${CONNECTOR_VERSION}` }]);
    if (href.includes("/git/ref/tags/")) return response({ ref: `refs/tags/v${CONNECTOR_VERSION}`, object: { type: "commit", sha } });
    if (href.endsWith("/package.json")) return response({ name: CONNECTOR_PACKAGE, version: CONNECTOR_VERSION, dsh: { bundle: { patch: "./dsh.bundle.patch.yml" } } });
    throw new Error(`unexpected URL: ${href}`);
  };
  const status = await performUpdateInstall({
    runtime,
    config: { autoUpdate: false, updateChannel: "stable" },
    pluginManager: pluginManager({ result: { application: "restart-required", bundle: CONNECTOR_PACKAGE, version: CONNECTOR_VERSION }, onInstall: (spec, options) => calls.push({ spec, options }) }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl,
    forceReinstall: true,
  });
  assert.equal(status.updateState, "restart-required", status.lastUpdateError);
  assert.equal(status.latestVersion, CONNECTOR_VERSION);
  assert.equal(status.updateSource, "github-releases");
  assert.deepEqual(calls, [{ spec: `${TRUSTED_SOURCE}#${sha}`, options: { enabled: false } }]);
});

test("update logic never mutates Credentials, pairing identity, Worker ID or Workspace authorization", async () => {
  const token = "local-secret-token-that-must-not-change";
  const config = {
    autoUpdate: true,
    updateChannel: "stable",
    workerId: "worker-identity-123",
    authorizedWorkspaceIds: ["workspace-a", "workspace-b"],
    trustedWorkspaceMode: true,
  };
  const before = structuredClone(config);
  const credentials = { LOCAL_WORKER_TOKEN: token };
  const pairingIdentity = { workerId: config.workerId, pairing: "paired" };

  const runtime = createUpdateRuntime();
  const status = await performUpdateInstall({
    runtime,
    config,
    pluginManager: pluginManager(),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
  });

  assert.equal(status.updateState, "restart-required");
  assert.deepEqual(config, before);
  assert.equal(credentials.LOCAL_WORKER_TOKEN, token);
  assert.equal(pairingIdentity.workerId, "worker-identity-123");
  assert.equal(pairingIdentity.pairing, "paired");
});

test("scheduler interval is capped at six hours", () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test("maintenance gate stays closed after install and reopens after a confirmed no-change failure", async () => {
  const runtime = createUpdateRuntime();
  let draining = false;
  const enterMaintenance = async () => { draining = true; };
  const leaveMaintenance = () => { draining = false; };

  const installed = await performUpdateInstall({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => assert.equal(draining, true) }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
    enterMaintenance,
    leaveMaintenance,
  });
  assert.equal(installed.updateState, "restart-required");
  assert.equal(draining, true, "claims remain disabled until the host restarts into installed code");

  const failedRuntime = createUpdateRuntime();
  let failureDrain = false;
  const failed = await performUpdateInstall({
    runtime: failedRuntime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ result: { changed: false, application: "failed", error: { code: "disk-full" } } }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
    enterMaintenance: async () => { failureDrain = true; },
    leaveMaintenance: () => { failureDrain = false; },
  });
  assert.equal(failed.updateState, "failed");
  assert.equal(failureDrain, false, "a confirmed no-change install failure safely resumes the old runtime");
});

test("ambiguous install and updater cancellation fail closed or safely release maintenance", async () => {
  const ambiguousRuntime = createUpdateRuntime();
  let ambiguousDrain = false;
  const ambiguous = await performUpdateInstall({
    runtime: ambiguousRuntime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ result: { changed: true, application: "failed", error: { code: "host-error" } } }),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
    enterMaintenance: async () => { ambiguousDrain = true; },
    leaveMaintenance: () => { ambiguousDrain = false; },
  });
  assert.equal(ambiguous.updateState, "failed");
  assert.equal(ambiguousDrain, true, "unknown on-disk state never resumes claims automatically");

  let wait;
  const reachedIdleWait = new Promise((resolve) => { wait = resolve; });
  const controller = new AbortController();
  const cancelledRuntime = createUpdateRuntime();
  let cancelledDrain = false;
  const pending = performUpdateInstall({
    runtime: cancelledRuntime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager(),
    harnessVersion: "1.0.0",
    profileContext: TRUSTED_PROFILE,
    fetchImpl: cloudOnly(manifest("0.8.0")),
    signal: controller.signal,
    isWorkerBusy: () => true,
    enterMaintenance: async () => { cancelledDrain = true; },
    leaveMaintenance: () => { cancelledDrain = false; },
    sleepImpl: async (_ms, signal) => {
      wait();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  });
  await reachedIdleWait;
  controller.abort(new Error("Harness is shutting down"));
  await assert.rejects(pending, /Harness is shutting down/);
  assert.equal(cancelledDrain, false, "cancellation before install reopens the old worker gate");
});
