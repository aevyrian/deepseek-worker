export const LEGACY_ORCHESTRATOR_BUNDLE_NAMES = Object.freeze([
  "@local/dsh-orchestrator-worker-preset",
  "dsh-orchestrator-worker-preset",
]);

function errorCode(result) {
  return result?.error?.code ?? null;
}

function successful(result) {
  return result?.application === "applied"
    || result?.application === "restart-required"
    || result?.application === "overridden";
}

export async function migrateLegacyOrchestratorBundles(pluginManager, logger = null) {
  if (pluginManager === undefined || pluginManager === null
    || typeof pluginManager.listBundles !== "function") {
    return { status: "unsupported", removed: [], pending: [], failed: [] };
  }

  let rows;
  try {
    rows = await pluginManager.listBundles();
  } catch (error) {
    logger?.warn?.("deepseek-worker: could not inspect legacy preset bundle state: %s", String(error));
    return { status: "failed", removed: [], pending: [], failed: [{ name: null, code: "list-failed" }] };
  }

  const legacy = Array.isArray(rows)
    ? rows.filter((row) => LEGACY_ORCHESTRATOR_BUNDLE_NAMES.includes(row?.name))
    : [];

  if (legacy.length === 0) {
    return { status: "clean", removed: [], pending: [], failed: [] };
  }

  const removed = [];
  const pending = [];
  const failed = [];

  for (const row of legacy) {
    const name = row.name;

    try {
      if (row.enabled === true && typeof pluginManager.setBundleEnabled === "function") {
        const disabled = await pluginManager.setBundleEnabled(name, false);
        if (disabled?.application === "restart-required") {
          pending.push({ name, reason: "restart-required" });
          continue;
        }
        if (!successful(disabled)) {
          failed.push({ name, code: errorCode(disabled) ?? "disable-failed" });
          continue;
        }
      }

      if (typeof pluginManager.removeBundle !== "function") {
        pending.push({ name, reason: "remove-unavailable" });
        continue;
      }

      const result = await pluginManager.removeBundle(name);
      if (result?.application === "restart-required" || result?.application === "applied") {
        removed.push(name);
        continue;
      }

      const code = errorCode(result);
      if (code === "stop-profile" || code === "bundle-in-use") {
        pending.push({ name, reason: code });
        continue;
      }

      failed.push({ name, code: code ?? "remove-failed" });
    } catch (error) {
      logger?.warn?.("deepseek-worker: legacy preset bundle migration failed for %s: %s", name, String(error));
      failed.push({ name, code: "exception" });
    }
  }

  const status = failed.length > 0 ? "failed" : pending.length > 0 ? "restart-required" : "cleaned";
  return { status, removed, pending, failed };
}
