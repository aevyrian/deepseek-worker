import test from "node:test";
import assert from "node:assert/strict";
import { authorizedWorkspaceState, workspaceHeartbeatPayload } from "../lib/workspaces.mjs";

test("authorized Workspace advertisement returns only stable ID and safe title", () => {
  const secret = "worker-token-secret";
  const state = authorizedWorkspaceState(["workspace-a"], [{
    id: "workspace-a",
    title: "My Project",
    path: "E:/private/project",
    cwd: "E:/private/project",
    token: secret,
    credential: secret,
  }]);
  assert.deepEqual(state.workspaces, [{ id: "workspace-a", name: "My Project" }]);
  const serialized = JSON.stringify(workspaceHeartbeatPayload(state));
  assert.equal(serialized.includes("E:/private/project"), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("cwd"), false);
  assert.equal(serialized.includes("path"), false);
  assert.equal(serialized.includes("token"), false);
});

test("path-looking Workspace titles are omitted rather than leaking a local path", () => {
  const state = authorizedWorkspaceState(["workspace-a"], [{
    id: "workspace-a",
    title: "C:\\Users\\Alice\\Secret",
    path: "C:\\Users\\Alice\\Secret",
  }]);
  assert.deepEqual(state.workspaces, [{ id: "workspace-a" }]);
});

test("multiple authorized Workspaces preserve configured order and omit unselected entries", () => {
  const state = authorizedWorkspaceState(["workspace-b", "workspace-a"], [
    { id: "workspace-a", title: "A" },
    { id: "workspace-b", name: "B" },
    { id: "workspace-c", title: "C" },
  ]);
  assert.deepEqual(state.workspaces, [
    { id: "workspace-b", name: "B" },
    { id: "workspace-a", name: "A" },
  ]);
  assert.deepEqual(state.missing, []);
});

test("deleted Workspace is removed from heartbeat state immediately", () => {
  const before = authorizedWorkspaceState(["workspace-a", "workspace-b"], [
    { id: "workspace-a", title: "A" },
    { id: "workspace-b", title: "B" },
  ]);
  const after = authorizedWorkspaceState(["workspace-a", "workspace-b"], [
    { id: "workspace-a", title: "A" },
  ]);
  assert.deepEqual(before.workspaceIds, ["workspace-a", "workspace-b"]);
  assert.deepEqual(after.workspaceIds, ["workspace-a"]);
  assert.deepEqual(after.missing, ["workspace-b"]);
});

test("newly authorized Workspace appears on the next presence snapshot", () => {
  const registry = [{ id: "workspace-a", title: "A" }, { id: "workspace-b", title: "B" }];
  const before = authorizedWorkspaceState(["workspace-a"], registry);
  const after = authorizedWorkspaceState(["workspace-a", "workspace-b"], registry);
  assert.deepEqual(before.workspaceIds, ["workspace-a"]);
  assert.deepEqual(after.workspaceIds, ["workspace-a", "workspace-b"]);
});

test("no authorized Workspace produces an explicit empty Cloud allowlist", () => {
  const state = authorizedWorkspaceState([], [{ id: "workspace-a", title: "A" }]);
  assert.deepEqual(workspaceHeartbeatPayload(state), { workspace_allowlist: [], workspaces: [] });
});