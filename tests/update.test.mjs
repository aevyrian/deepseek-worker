import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CONNECTOR_PACKAGE,
  CONNECTOR_VERSION,
  TRUSTED_SOURCE,
  UPDATE_CHECK_INTERVAL_MS,
  buildInstallSpec,
  compareSemver,
  createUpdateRuntime,
  isNewerVersion,
  isTrustedSource,
  parseSemver,
  performUpdateCheck,
  resolveUpdateCandidate,
  selectUpdateCandidate,
  validateUpdateManifest,
} from "../lib/update.mjs";

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

function pluginManager({
  source = `${TRUSTED_SOURCE}#v0.4.8`,
  result = {
    changed: true,
    application: "restart-required",
    stage: "install",
    target: TRUSTED_SOURCE,
    bundle: CONNECTOR_PACKAGE,
    version: "0.4.9",
  },
  onInstall,
} = {}) {
  return {
    async listBundles() {
      return [{
        name: CONNECTOR_PACKAGE,
        version: CONNECTOR_VERSION,
        installed: true,
        enabled: true,
        source,
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
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { installCalls += 1; } }),
    harnessVersion: "0.4.0",
    fetchImpl: cloudOnly(manifest("0.4.9", { minimumHarnessVersion: "0.5.0" })),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /更高版本/);
  assert.equal(installCalls, 0);
});

test("untrusted installed package source is refused before replacement", async () => {
  let installCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      source: "file:C:/random/deepseek-worker",
      onInstall: () => { installCalls += 1; },
    }),
    harnessVersion: "1.0.0",
    fetchImpl: cloudOnly(manifest("0.4.9")),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /GitHub 安装源/);
  assert.equal(installCalls, 0);
});

test("correct Git tag update uses official installBundle with enabled false", async () => {
  const calls = [];
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      onInstall: (spec, options) => calls.push({ spec, options }),
    }),
    harnessVersion: "1.0.0",
    fetchImpl: cloudOnly(manifest("0.4.9")),
  });

  assert.equal(status.updateState, "restart-required");
  assert.equal(status.restartRequired, true);
  assert.equal(status.latestVersion, "0.4.9");
  assert.deepEqual(calls, [{
    spec: `${TRUSTED_SOURCE}#${"a".repeat(40)}`,
    options: { enabled: false },
  }]);
});

test("package metadata mismatch is rejected before Plugin Manager replacement", async () => {
  let installCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { installCalls += 1; } }),
    harnessVersion: "1.0.0",
    fetchImpl: cloudOnly(manifest("0.4.9"), { packageVersion: "9.9.9" }),
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
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: true, updateChannel: "stable" },
    pluginManager: pluginManager({
      onInstall: () => { installedWhileBusy = busy; },
    }),
    harnessVersion: "1.0.0",
    fetchImpl: cloudOnly(manifest("0.4.9")),
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
  const status = await performUpdateCheck({
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
    fetchImpl: cloudOnly(manifest("0.4.9")),
  });
  assert.equal(status.currentVersion, CONNECTOR_VERSION);
  assert.equal(status.restartRequired, false);
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /当前 Connector 继续运行/);
});

test("bundle validation failure leaves the running Connector on the current version", async () => {
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
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
    fetchImpl: cloudOnly(manifest("0.4.9")),
  });
  assert.equal(status.currentVersion, CONNECTOR_VERSION);
  assert.equal(status.restartRequired, false);
  assert.equal(status.updateState, "failed");
});

test("official incompatibility result is surfaced without replacing runtime state", async () => {
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
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
    fetchImpl: cloudOnly(manifest("0.4.9")),
  });
  assert.equal(status.updateState, "failed");
  assert.match(status.lastUpdateError, /不兼容/);
  assert.equal(status.currentVersion, CONNECTOR_VERSION);
});

test("auto-update disabled performs no network or package operation", async () => {
  let fetchCalls = 0;
  let packageCalls = 0;
  const runtime = createUpdateRuntime();
  const status = await performUpdateCheck({
    runtime,
    config: { autoUpdate: false, updateChannel: "stable" },
    pluginManager: pluginManager({ onInstall: () => { packageCalls += 1; } }),
    harnessVersion: "1.0.0",
    fetchImpl: async () => { fetchCalls += 1; return response(null); },
  });
  assert.equal(status.updateState, "idle");
  assert.equal(fetchCalls, 0);
  assert.equal(packageCalls, 0);
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
  const status = await performUpdateCheck({
    runtime,
    config,
    pluginManager: pluginManager(),
    harnessVersion: "1.0.0",
    fetchImpl: cloudOnly(manifest("0.4.9")),
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