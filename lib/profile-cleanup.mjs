import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// This is the flattened order emitted by the retired standalone preset bundle.
// Child IDs such as tool-fs are shared with other presets and are never removed
// unless the entire contiguous, disable-only signature is present.
export const LEGACY_DISABLED_SIGNATURE = Object.freeze([
  "preset-orchestrator-worker", "orchestrator-worker", "persona", "agent-instructions",
  "tool-bash", "tool-pwsh", "tool-fs", "tool-fs-search", "tool-jobs",
  "skill-filesystem", "tool-skill", "command-goal", "tool-goal", "planning",
  "plan-mode", "compaction", "compaction-basic", "command-compact",
  "tool-result-pruner", "delegation", "tool-subagent-control",
  "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork",
  "tool-subagent-codex", "tool-subagent-claude-code", "workflow-ptc",
  "tool-workflow", "tool-ralph", "tool-ask-user", "tool-todo", "tool-web",
  "present", "tool-plugin-manager",
]);

function splitRows(source) {
  const lines = source.split(/(?<=\n)/);
  const rows = [];
  let current = { id: null, lines: [] };
  for (const line of lines) {
    const match = line.match(/^- id: ([A-Za-z0-9._:-]+)\s*\r?\n?$/);
    if (match) {
      rows.push(current);
      current = { id: match[1], lines: [line] };
    } else current.lines.push(line);
  }
  rows.push(current);
  return rows.filter((row) => row.lines.length > 0);
}
function onlyDisabled(row) {
  return row.lines.join("").replace(/\r/g, "").trim() === `- id: ${row.id}\n  disabled: true`;
}
function fields(row) {
  const lines = row.lines.slice(1);
  const result = new Map();
  let key = null;
  for (const line of lines) {
    const found = line.match(/^  ([A-Za-z][A-Za-z0-9_]*):/);
    if (found) { key = found[1]; result.set(key, [line]); }
    else if (key !== null) result.get(key).push(line);
    else if (line.trim()) return null;
  }
  return result;
}
function configFields(lines) {
  const result = new Map();
  let key = null;
  for (const line of lines.slice(1)) {
    const found = line.match(/^    ([A-Za-z][A-Za-z0-9_]*):/);
    if (found) { key = found[1]; result.set(key, [line]); }
    else if (key !== null) result.get(key).push(line);
    else if (line.trim()) return null;
  }
  return result;
}
function mergeConnectorRows(first, last) {
  const oldFields = fields(first), activeFields = fields(last);
  if (!oldFields || !activeFields || !oldFields.has("config") || !activeFields.has("config")) return null;
  const oldConfig = configFields(oldFields.get("config"));
  const activeConfig = configFields(activeFields.get("config"));
  if (!oldConfig || !activeConfig) return null;
  // The last Loader row supplies effective values. Earlier fields only fill gaps.
  for (const [key, lines] of oldConfig) if (!activeConfig.has(key)) activeConfig.set(key, lines);
  activeFields.set("config", [activeFields.get("config")[0], ...[...activeConfig.values()].flat()]);
  for (const [key, lines] of oldFields) if (!activeFields.has(key)) activeFields.set(key, lines);
  return { id: last.id, lines: [last.lines[0], ...[...activeFields.values()].flat()] };
}

export function planLegacyProfilePatch(source) {
  const rows = splitRows(source);
  const removed = [];
  let ambiguous = false;
  const firstLegacy = rows.findIndex((row) => row.id === LEGACY_DISABLED_SIGNATURE[0]);
  if (firstLegacy >= 0) {
    const match = LEGACY_DISABLED_SIGNATURE.every((id, offset) => rows[firstLegacy + offset]?.id === id && onlyDisabled(rows[firstLegacy + offset]));
    if (match) {
      removed.push(...LEGACY_DISABLED_SIGNATURE);
      rows.splice(firstLegacy, LEGACY_DISABLED_SIGNATURE.length);
    } else ambiguous = true;
  }
  const connectorIndices = rows.flatMap((row, index) => row.id === "deepseek-worker-connector" ? [index] : []);
  if (connectorIndices.length === 2) {
    const merged = mergeConnectorRows(rows[connectorIndices[0]], rows[connectorIndices[1]]);
    if (merged) {
      rows[connectorIndices[1]] = merged;
      rows.splice(connectorIndices[0], 1);
      removed.push("duplicate-deepseek-worker-connector");
    } else ambiguous = true;
  } else if (connectorIndices.length > 2) ambiguous = true;
  const next = rows.flatMap((row) => row.lines).join("");
  return { content: next, changed: next !== source, removed, ambiguous };
}

async function verifyLegacySource(source) {
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return false;
  const real = await fs.realpath(source);
  const entries = (await fs.readdir(real)).sort();
  if (entries.join("|") !== "cordis.patch.yml|package.json") return false;
  const pkg = JSON.parse(await fs.readFile(join(real, "package.json"), "utf8"));
  if (pkg.name !== "@local/dsh-orchestrator-worker-preset" || pkg.dsh?.bundle?.patch !== "./cordis.patch.yml") return false;
  const patch = await fs.readFile(join(real, "cordis.patch.yml"), "utf8");
  return patch.includes("- id: preset-orchestrator-worker") && patch.includes("id: orchestrator-worker");
}

export async function migrateLegacyProfileArtifacts(pluginManager, logger = null) {
  const profileDir = pluginManager?.profile?.dir;
  if (typeof profileDir !== "string") return { status: "unsupported", patchChanged: false, linkRemoved: false, sourceRetired: false };
  const profile = await fs.realpath(profileDir);
  const patchFile = join(profile, "cordis.patch.yml");
  const original = await fs.readFile(patchFile, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const plan = planLegacyProfilePatch(original);
  if (plan.changed) {
    const fingerprint = createHash("sha256").update(original).digest("hex").slice(0, 16);
    const backup = join(profile, `cordis.patch.yml.deepseek-worker-${fingerprint}.bak`);
    const temporary = join(profile, `.cordis.patch.yml.deepseek-worker-${process.pid}.tmp`);
    await fs.writeFile(backup, original, { flag: "wx", mode: 0o600 }).catch(async (error) => {
      if (error.code !== "EEXIST" || await fs.readFile(backup, "utf8") !== original) throw error;
    });
    try {
      await fs.writeFile(temporary, plan.content, { flag: "wx", mode: 0o600 });
      if (await fs.readFile(patchFile, "utf8") !== original) throw new Error("Profile patch changed during migration");
      await fs.rename(temporary, patchFile);
    } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }

  let linkRemoved = false, sourceRetired = false;
  const link = join(profile, "node_modules", "@local", "dsh-orchestrator-worker-preset");
  const linkStat = await fs.lstat(link).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (linkStat?.isSymbolicLink()) {
    const target = resolve(dirname(link), await fs.readlink(link));
    const targetStat = await fs.lstat(target).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (basename(target) === "orchestrator-worker-preset" && (!targetStat || await verifyLegacySource(target))) {
      // Retire only the exact two-file legacy source. Keep its contents recoverable.
      const retired = `${target}.retired-deepseek-worker-0.4.8`;
      const existing = await fs.lstat(retired).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (!targetStat || !existing) {
        await fs.unlink(link);
        linkRemoved = true;
      }
      if (targetStat && !existing) {
        await fs.rename(target, retired);
        sourceRetired = true;
      }
    }
  }
  if (plan.ambiguous) logger?.warn?.("deepseek-worker: ambiguous legacy patch rows were preserved");
  return { status: plan.ambiguous ? "partial" : "clean", patchChanged: plan.changed, removed: plan.removed, linkRemoved, sourceRetired };
}
