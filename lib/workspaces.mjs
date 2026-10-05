import { normalizeAuthorizedWorkspaceIds } from "./connector-config.mjs";

const DISPLAY_KEYS = ["title", "name"];
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|[/\\]{1,2}|file:)/u;

function safeDisplayName(workspace) {
  for (const key of DISPLAY_KEYS) {
    const value = workspace?.[key];
    if (typeof value !== "string") continue;
    const name = value.trim().replace(/[\u0000-\u001f\u007f]/gu, " ");
    if (!name || PATH_LIKE.test(name)) continue;
    const localPath = typeof workspace?.path === "string" ? workspace.path.trim() : "";
    if (localPath && name === localPath) continue;
    return name.slice(0, 200);
  }
  return null;
}

export function authorizedWorkspaceState(authorizedWorkspaceIds, registryEntries) {
  const selected = normalizeAuthorizedWorkspaceIds(authorizedWorkspaceIds);
  const byId = new Map();
  for (const workspace of Array.isArray(registryEntries) ? registryEntries : []) {
    if (workspace?.id === undefined || workspace?.id === null) continue;
    byId.set(String(workspace.id), workspace);
  }

  const workspaces = [];
  const missing = [];
  for (const id of selected) {
    const workspace = byId.get(id);
    if (!workspace) {
      missing.push(id);
      continue;
    }
    const advertised = { id };
    const name = safeDisplayName(workspace);
    if (name) advertised.name = name;
    workspaces.push(advertised);
  }

  return Object.freeze({
    configuredCount: selected.length,
    count: workspaces.length,
    missing: Object.freeze(missing),
    workspaceIds: Object.freeze(workspaces.map((workspace) => workspace.id)),
    workspaces: Object.freeze(workspaces.map((workspace) => Object.freeze(workspace))),
  });
}

export function workspaceHeartbeatPayload(state) {
  return {
    workspace_allowlist: [...state.workspaceIds],
    workspaces: state.workspaces.map((workspace) => ({ ...workspace })),
  };
}