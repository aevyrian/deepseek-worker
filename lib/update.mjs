import { setTimeout as delay } from "node:timers/promises";

export const CONNECTOR_PACKAGE = "deepseek-worker-connector";
export const CONNECTOR_VERSION = "0.7.9";
export const TRUSTED_REPOSITORY = "aevyrian/deepseek-worker";
export const TRUSTED_SOURCE = "https://github.com/aevyrian/deepseek-worker.git";
export const CLOUD_UPDATE_MANIFEST_URL = "https://deepseek-worker.sxfdgan.chatgpt.site/api/connector/latest";
export const GITHUB_RELEASES_URL = "https://api.github.com/repos/aevyrian/deepseek-worker/releases?per_page=30";
export const GITHUB_TAGS_URL = "https://api.github.com/repos/aevyrian/deepseek-worker/tags?per_page=100";
export const GITHUB_TAG_REF_BASE = "https://api.github.com/repos/aevyrian/deepseek-worker/git/ref/tags/";
export const GITHUB_TAG_OBJECT_BASE = "https://api.github.com/repos/aevyrian/deepseek-worker/git/tags/";
export const RAW_PACKAGE_BASE = "https://raw.githubusercontent.com/aevyrian/deepseek-worker/";
export const UPDATE_START_DELAY_MS = 20_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_IDLE_POLL_MS = 1_000;

const MANIFEST_FIELDS = new Set([
  "version",
  "channel",
  "source",
  "ref",
  "minimumHarnessVersion",
  "mandatory",
  "notes",
]);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

export function parseSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split(".").map((part) => (
    /^\d+$/u.test(part) ? BigInt(part) : part
  ));
  return {
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
    build: match[5] || "",
  };
}

function compareIdentifier(a, b) {
  if (a === b) return 0;
  const aNumber = typeof a === "bigint";
  const bNumber = typeof b === "bigint";
  if (aNumber && bNumber) return a < b ? -1 : 1;
  if (aNumber) return -1;
  if (bNumber) return 1;
  return String(a) < String(b) ? -1 : 1;
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) throw new UpdateError("invalid-semver", "更新版本号不是合法的 Semantic Version。");
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const compared = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function isPrerelease(version) {
  const parsed = parseSemver(version);
  if (!parsed) throw new UpdateError("invalid-semver", "更新版本号不是合法的 Semantic Version。");
  return parsed.prerelease.length > 0;
}

export function isNewerVersion(candidate, current) {
  return compareSemver(candidate, current) > 0;
}

export function normalizeUpdateChannel(value) {
  return value === "preview" ? "preview" : "stable";
}

export function isTrustedSource(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  let spec = value.trim();
  const aliasPrefix = `${CONNECTOR_PACKAGE}@`;
  if (spec.startsWith(aliasPrefix)) spec = spec.slice(aliasPrefix.length);

  if (/^github:aevyrian\/deepseek-worker(?:#[-0-9A-Za-z.+]+)?$/u.test(spec)) return true;
  if (/^git\+https:\/\/github\.com\/aevyrian\/deepseek-worker(?:\.git)?(?:#[-0-9A-Za-z.+]+)?$/u.test(spec)) return true;

  try {
    const withoutGitPrefix = spec.replace(/^git\+/u, "");
    const url = new URL(withoutGitPrefix);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) return false;
    if (url.search) return false;
    const pathname = url.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "").toLowerCase();
    if (pathname !== "/aevyrian/deepseek-worker") return false;
    if (url.hash && !/^#(?:v[0-9A-Za-z.+-]+|[0-9a-f]{40})$/u.test(url.hash)) return false;
    return true;
  } catch {
    return false;
  }
}

function exactRefForVersion(ref, version) {
  if (typeof ref !== "string" || !ref) {
    throw new UpdateError("invalid-ref", "更新清单缺少精确 Git ref。");
  }
  if (COMMIT_SHA.test(ref)) return ref;
  if (!TAG.test(ref) || ref !== `v${version}`) {
    throw new UpdateError("invalid-ref", "更新 ref 必须是与版本一致的正式 tag 或精确 commit SHA。");
  }
  return ref;
}

export function validateUpdateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdateError("invalid-manifest", "更新清单格式无效。");
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_FIELDS.has(key)) {
      throw new UpdateError("invalid-manifest", `更新清单包含不允许的字段：${key}。`);
    }
  }

  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (!parseSemver(version)) throw new UpdateError("invalid-semver", "更新清单中的 version 不是合法 Semantic Version。");

  const channel = value.channel;
  if (channel !== "stable" && channel !== "preview") {
    throw new UpdateError("invalid-channel", "更新清单中的 channel 必须是 stable 或 preview。");
  }
  if (channel === "stable" && isPrerelease(version)) {
    throw new UpdateError("invalid-channel", "stable 更新不能声明 prerelease 版本。");
  }

  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (!isTrustedSource(source) || source.includes("#")) {
    throw new UpdateError("untrusted-source", "更新来源不是受信任的 aevyrian/deepseek-worker，或 source 非规范化仓库地址。");
  }

  const ref = exactRefForVersion(value.ref, version);
  let minimumHarnessVersion = null;
  if (value.minimumHarnessVersion !== undefined && value.minimumHarnessVersion !== null && value.minimumHarnessVersion !== "") {
    minimumHarnessVersion = String(value.minimumHarnessVersion).trim();
    if (!parseSemver(minimumHarnessVersion)) {
      throw new UpdateError("invalid-harness-version", "minimumHarnessVersion 不是合法 Semantic Version。");
    }
  }
  if (value.mandatory !== undefined && typeof value.mandatory !== "boolean") {
    throw new UpdateError("invalid-manifest", "mandatory 必须是布尔值。");
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    throw new UpdateError("invalid-manifest", "notes 必须是字符串。");
  }
  if (typeof value.notes === "string" && value.notes.length > 20_000) {
    throw new UpdateError("invalid-manifest", "notes 超过允许长度。");
  }

  return Object.freeze({
    version,
    channel,
    source: TRUSTED_SOURCE,
    ref,
    minimumHarnessVersion,
    mandatory: value.mandatory === true,
    notes: value.notes || "",
  });
}

export function buildInstallSpec(manifest, resolvedRef) {
  const validated = validateUpdateManifest(manifest);
  const ref = resolvedRef === undefined ? validated.ref : resolvedRef;
  if (ref !== validated.ref && !COMMIT_SHA.test(ref)) {
    throw new UpdateError("invalid-resolved-ref", "解析后的更新 ref 不是精确 commit SHA。");
  }
  return `${TRUSTED_SOURCE}#${ref}`;
}

async function githubJson(url, fetchImpl, signal, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "deepseek-worker-connector/0.7.0",
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UpdateError("github-network", `无法访问 ${label}。`);
  }
  if (!response.ok) {
    throw new UpdateError("github-ref-http", `${label} 返回 HTTP ${response.status}。`);
  }
  return responseJson(response, label);
}

async function peelTagObject(object, fetchImpl, signal, depth = 0) {
  if (!object || typeof object !== "object" || typeof object.sha !== "string") {
    throw new UpdateError("invalid-tag-ref", "GitHub tag ref 响应无效。");
  }
  if (object.type === "commit" && COMMIT_SHA.test(object.sha)) return object.sha;
  if (object.type !== "tag" || !COMMIT_SHA.test(object.sha) || depth >= 4) {
    throw new UpdateError("invalid-tag-ref", "GitHub tag 没有解析到精确 commit。");
  }
  const tag = await githubJson(`${GITHUB_TAG_OBJECT_BASE}${object.sha}`, fetchImpl, signal, "GitHub tag object");
  return peelTagObject(tag?.object, fetchImpl, signal, depth + 1);
}

export async function resolveTrustedInstallRef(manifest, { fetchImpl = fetch, signal } = {}) {
  const validated = validateUpdateManifest(manifest);
  if (COMMIT_SHA.test(validated.ref)) return validated.ref;
  const tagRef = await githubJson(
    `${GITHUB_TAG_REF_BASE}${encodeURIComponent(validated.ref)}`,
    fetchImpl,
    signal,
    "GitHub tag ref",
  );
  if (tagRef?.ref !== `refs/tags/${validated.ref}`) {
    throw new UpdateError("invalid-tag-ref", "GitHub 返回的 tag ref 与请求版本不一致。");
  }
  return peelTagObject(tagRef.object, fetchImpl, signal);
}

export async function verifyTrustedPackage(manifest, resolvedRef, { fetchImpl = fetch, signal } = {}) {
  const validated = validateUpdateManifest(manifest);
  if (!COMMIT_SHA.test(resolvedRef)) {
    throw new UpdateError("invalid-resolved-ref", "更新包验证要求精确 commit SHA。");
  }
  let response;
  const url = `${RAW_PACKAGE_BASE}${resolvedRef}/package.json`;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new UpdateError("github-network", "无法读取受信任更新 commit 的 package.json。");
  }
  if (!response.ok) {
    throw new UpdateError("package-metadata-http", `更新 package.json 返回 HTTP ${response.status}。`);
  }
  const pkg = await responseJson(response, "更新 package.json");
  if (
    !pkg
    || pkg.name !== CONNECTOR_PACKAGE
    || pkg.version !== validated.version
    || pkg?.dsh?.bundle?.patch !== "./dsh.bundle.patch.yml"
  ) {
    throw new UpdateError("package-metadata-mismatch", "更新 commit 的 package name/version/bundle metadata 与清单不一致。");
  }
  return Object.freeze({ name: pkg.name, version: pkg.version, ref: resolvedRef });
}

function channelAccepts(channel, candidate) {
  if (channel === "stable") return candidate.channel === "stable" && !isPrerelease(candidate.version);
  return candidate.channel === "stable" || candidate.channel === "preview";
}

export function selectUpdateCandidate(candidates, currentVersion, channel) {
  if (!parseSemver(currentVersion)) throw new UpdateError("invalid-current-version", "当前 Connector 版本不是合法 Semantic Version。");
  const normalizedChannel = normalizeUpdateChannel(channel);
  const valid = [];
  for (const candidate of candidates) {
    let normalized;
    try {
      normalized = validateUpdateManifest(candidate);
    } catch {
      continue;
    }
    if (!channelAccepts(normalizedChannel, normalized)) continue;
    if (!isNewerVersion(normalized.version, currentVersion)) continue;
    valid.push(normalized);
  }
  valid.sort((a, b) => compareSemver(b.version, a.version));
  return valid[0] || null;
}

async function responseJson(response, label) {
  const text = await response.text();
  if (text.length > 1_000_000) throw new UpdateError("manifest-too-large", `${label} 响应超过大小限制。`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new UpdateError("invalid-json", `${label} 返回的 JSON 无效。`);
  }
}

function fallbackStatus(status) {
  return status === 404 || status === 405 || status === 501 || status >= 500;
}

async function cloudCandidate({ fetchImpl, currentVersion, channel, signal }) {
  let response;
  try {
    response = await fetchImpl(CLOUD_UPDATE_MANIFEST_URL, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { accept: "application/json" },
    });
  } catch {
    return { fallback: true };
  }
  if (!response.ok) {
    if (fallbackStatus(response.status)) return { fallback: true };
    throw new UpdateError("cloud-manifest-http", `Cloud 更新清单返回 HTTP ${response.status}。`);
  }
  const parsed = await responseJson(response, "Cloud 更新清单");
  const manifest = validateUpdateManifest(parsed);
  if (!channelAccepts(normalizeUpdateChannel(channel), manifest)) return { candidate: null };
  if (!isNewerVersion(manifest.version, currentVersion)) return { candidate: null };
  return { candidate: manifest };
}

function manifestFromTag(tagName, preview = false) {
  if (typeof tagName !== "string" || !TAG.test(tagName)) return null;
  const version = tagName.slice(1);
  const prerelease = isPrerelease(version);
  return {
    version,
    channel: preview || prerelease ? "preview" : "stable",
    source: TRUSTED_SOURCE,
    ref: tagName,
    minimumHarnessVersion: null,
    mandatory: false,
    notes: "",
  };
}

async function githubCandidates({ fetchImpl, signal }) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "deepseek-worker-connector/0.7.0",
  };

  let releases = [];
  let tags = [];
  let lastError;

  try {
    const response = await fetchImpl(GITHUB_RELEASES_URL, { method: "GET", redirect: "error", signal, headers });
    if (response.ok) {
      const parsed = await responseJson(response, "GitHub Releases");
      if (Array.isArray(parsed)) {
        releases = parsed.flatMap((release) => {
          if (!release || release.draft === true) return [];
          const candidate = manifestFromTag(release.tag_name, release.prerelease === true);
          return candidate ? [{ ...candidate, notes: typeof release.body === "string" ? release.body.slice(0, 20_000) : "" }] : [];
        });
      }
    } else {
      lastError = new UpdateError("github-http", `GitHub Releases 返回 HTTP ${response.status}。`);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    lastError = new UpdateError("github-network", "无法访问 GitHub 更新源。");
  }

  try {
    const response = await fetchImpl(GITHUB_TAGS_URL, { method: "GET", redirect: "error", signal, headers });
    if (response.ok) {
      const parsed = await responseJson(response, "GitHub Tags");
      if (Array.isArray(parsed)) tags = parsed.flatMap((tag) => {
        const candidate = manifestFromTag(tag?.name, false);
        return candidate ? [candidate] : [];
      });
    } else if (releases.length === 0) {
      lastError = new UpdateError("github-http", `GitHub Tags 返回 HTTP ${response.status}。`);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (releases.length === 0) lastError = new UpdateError("github-network", "无法访问 GitHub 更新源。");
  }

  if (releases.length === 0 && tags.length === 0 && lastError) throw lastError;
  const byVersion = new Map();
  for (const candidate of [...releases, ...tags]) {
    if (!byVersion.has(candidate.version)) byVersion.set(candidate.version, candidate);
  }
  return [...byVersion.values()];
}

export async function resolveUpdateCandidate({
  currentVersion = CONNECTOR_VERSION,
  channel = "stable",
  fetchImpl = fetch,
  signal,
} = {}) {
  const cloud = await cloudCandidate({ fetchImpl, currentVersion, channel, signal });
  if (!cloud.fallback) return cloud.candidate || null;
  const candidates = await githubCandidates({ fetchImpl, signal });
  return selectUpdateCandidate(candidates, currentVersion, channel);
}

export function createUpdateRuntime(currentVersion = CONNECTOR_VERSION) {
  return {
    currentVersion,
    installedVersion: currentVersion,
    latestVersion: currentVersion,
    updateState: "idle",
    lastCheckedAt: null,
    restartRequired: false,
    lastUpdateError: null,
  };
}

export function publicUpdateStatus(runtime) {
  return Object.freeze({
    currentVersion: runtime.currentVersion || CONNECTOR_VERSION,
    installedVersion: runtime.installedVersion || runtime.currentVersion || CONNECTOR_VERSION,
    latestVersion: runtime.latestVersion || runtime.installedVersion || runtime.currentVersion || CONNECTOR_VERSION,
    updateState: runtime.updateState || "idle",
    lastCheckedAt: runtime.lastCheckedAt || null,
    restartRequired: runtime.restartRequired === true,
    lastUpdateError: runtime.lastUpdateError || null,
  });
}

function setFailure(runtime, error) {
  const updateError = error instanceof UpdateError
    ? error
    : new UpdateError("update-failed", "自动更新失败。当前版本仍可继续使用。");
  runtime.updateState = "failed";
  runtime.restartRequired = false;
  runtime.lastUpdateError = updateError.message;
  return publicUpdateStatus(runtime);
}

function trustedInstalledBundle(bundle) {
  return bundle
    && bundle.name === CONNECTOR_PACKAGE
    && bundle.installed === true
    && typeof bundle.source === "string"
    && isTrustedSource(bundle.source);
}

async function waitForWorkerIdle(isWorkerBusy, signal, sleepImpl) {
  if (signal?.aborted) throw signal.reason || new Error("Update check aborted");
  while (isWorkerBusy()) {
    if (signal?.aborted) throw signal.reason || new Error("Update check aborted");
    await sleepImpl(UPDATE_IDLE_POLL_MS, signal);
  }
}

export async function performUpdateCheck({
  runtime,
  config,
  pluginManager,
  harnessVersion,
  isWorkerBusy = () => false,
  enterMaintenance = async () => {},
  leaveMaintenance = () => {},
  fetchImpl = fetch,
  signal,
  sleepImpl = async (ms, activeSignal) => {
    await delay(ms, undefined, activeSignal ? { signal: activeSignal } : undefined);
  },
  force = false,
} = {}) {
  if (!runtime) throw new TypeError("update runtime is required");
  runtime.currentVersion = CONNECTOR_VERSION;
  let maintenanceEntered = false;
  let safeToResume = true;

  if (!force && config?.autoUpdate === false) {
    runtime.updateState = "idle";
    runtime.lastUpdateError = null;
    return publicUpdateStatus(runtime);
  }
  if (runtime.restartRequired) return publicUpdateStatus(runtime);

  runtime.updateState = "checking";
  runtime.lastUpdateError = null;
  try {
    const candidate = await resolveUpdateCandidate({
      currentVersion: CONNECTOR_VERSION,
      channel: normalizeUpdateChannel(config?.updateChannel),
      fetchImpl,
      signal,
    });
    runtime.lastCheckedAt = new Date().toISOString();

    if (!candidate) {
      runtime.latestVersion = CONNECTOR_VERSION;
      runtime.updateState = "up-to-date";
      return publicUpdateStatus(runtime);
    }

    runtime.latestVersion = candidate.version;
    runtime.updateState = "available";

    if (candidate.minimumHarnessVersion) {
      if (!parseSemver(harnessVersion)) {
        throw new UpdateError("harness-version-unavailable", "无法确认当前 DeepSeek Harness 版本，已拒绝自动更新。");
      }
      if (compareSemver(harnessVersion, candidate.minimumHarnessVersion) < 0) {
        throw new UpdateError("harness-incompatible", "新版本需要更高版本的 DeepSeek Harness，已拒绝自动更新。");
      }
    }

    if (!pluginManager || typeof pluginManager.listBundles !== "function" || typeof pluginManager.installBundle !== "function") {
      throw new UpdateError("plugin-manager-unavailable", "Harness Plugin Manager 不可用，当前版本继续运行。");
    }

    const bundles = await pluginManager.listBundles();
    const installed = Array.isArray(bundles)
      ? bundles.find((bundle) => bundle?.name === CONNECTOR_PACKAGE)
      : undefined;
    if (!trustedInstalledBundle(installed)) {
      throw new UpdateError("installed-source-untrusted", "当前 Connector 不是从受信任的 GitHub 安装源安装，已拒绝自动覆盖。");
    }

    const resolvedRef = await resolveTrustedInstallRef(candidate, { fetchImpl, signal });
    await verifyTrustedPackage(candidate, resolvedRef, { fetchImpl, signal });

    runtime.updateState = "waiting-idle";
    maintenanceEntered = true;
    await enterMaintenance();
    await waitForWorkerIdle(isWorkerBusy, signal, sleepImpl);
    runtime.updateState = "installing";

    const spec = buildInstallSpec(candidate, resolvedRef);
    safeToResume = false;
    const result = await pluginManager.installBundle(spec, { enabled: false });
    if (!result || result.application === "failed" || result.application === "cancelled") {
      safeToResume = Boolean(result)
        && ["failed", "cancelled"].includes(result.application)
        && result.changed !== true;
      const code = result?.error?.code === "incompatible-version" ? "harness-incompatible" : "install-failed";
      const message = code === "harness-incompatible"
        ? "新版本与当前 DeepSeek Harness 不兼容，已拒绝自动更新。"
        : "自动更新安装失败。当前 Connector 继续运行。";
      throw new UpdateError(code, message);
    }
    // Once the installer reports a potentially applied or ambiguous result,
    // keep claims closed until the host is restarted and reports loaded code.
    safeToResume = false;
    if (result.application !== "restart-required") {
      throw new UpdateError("unexpected-application", "Harness 未返回 restart-required，已停止自动更新流程。");
    }
    if (result.bundle !== CONNECTOR_PACKAGE) {
      throw new UpdateError("package-mismatch", "Harness 安装结果不是 DeepSeek Worker Connector，已停止自动更新流程。");
    }
    if (typeof result.version === "string" && result.version !== candidate.version) {
      throw new UpdateError("version-mismatch", "Harness 安装到的版本与更新清单不一致，请不要重启并检查安装源。");
    }

    runtime.latestVersion = candidate.version;
    runtime.updateState = "restart-required";
    runtime.restartRequired = true;
    runtime.lastUpdateError = null;
    return publicUpdateStatus(runtime);
  } catch (error) {
    if (signal?.aborted) throw error;
    return setFailure(runtime, error);
  } finally {
    if (maintenanceEntered && safeToResume && !runtime.restartRequired) {
      leaveMaintenance();
    }
  }
}

export class AutoUpdateController {
  constructor({
    runtime,
    getConfig,
    getPluginManager,
    getHarnessVersion,
    isWorkerBusy,
    enterMaintenance = async () => {},
    leaveMaintenance = () => {},
    fetchImpl = fetch,
    sleepImpl,
    logger,
  }) {
    this.runtime = runtime;
    this.getConfig = getConfig;
    this.getPluginManager = getPluginManager;
    this.getHarnessVersion = getHarnessVersion;
    this.isWorkerBusy = isWorkerBusy;
    this.enterMaintenance = enterMaintenance;
    this.leaveMaintenance = leaveMaintenance;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
    this.logger = logger;
    this.active = null;
  }

  requestCheck({ force = false, signal } = {}) {
    if (this.active) return this.active;
    const task = performUpdateCheck({
      runtime: this.runtime,
      config: this.getConfig(),
      pluginManager: this.getPluginManager(),
      harnessVersion: this.getHarnessVersion(),
      isWorkerBusy: this.isWorkerBusy,
      enterMaintenance: this.enterMaintenance,
      leaveMaintenance: this.leaveMaintenance,
      fetchImpl: this.fetchImpl,
      signal,
      ...(this.sleepImpl ? { sleepImpl: this.sleepImpl } : {}),
      force,
    }).catch((error) => {
      if (!signal?.aborted) {
        this.runtime.updateState = "failed";
        this.runtime.lastUpdateError = "自动更新失败。当前版本仍可继续使用。";
        this.logger?.warn?.("deepseek-worker auto-update failed: %s", error instanceof Error ? error.message : String(error));
      }
      return publicUpdateStatus(this.runtime);
    }).finally(() => {
      if (this.active === task) this.active = null;
    });
    this.active = task;
    return task;
  }

  async runScheduler(signal) {
    try {
      await delay(UPDATE_START_DELAY_MS, undefined, { signal });
      while (!signal.aborted) {
        if (!this.runtime.restartRequired && this.getConfig().autoUpdate !== false) {
          await this.requestCheck({ signal });
        }
        await delay(UPDATE_CHECK_INTERVAL_MS, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
