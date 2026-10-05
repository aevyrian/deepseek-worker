# Workspace discovery contract — 0.3.3

Connector 0.3.3 keeps Harness Workspace authorization local and adds only a safe Cloud projection so ChatGPT can discover a valid `workspace_id` before submitting local work.

## Connector -> Cloud presence

Register and heartbeat may include:

```json
{
  "workspace_allowlist": ["workspace-stable-id"],
  "workspaces": [
    {
      "id": "workspace-stable-id",
      "name": "Optional safe title"
    }
  ]
}
```

Only the stable Harness Workspace ID and an optional explicit title/name are serialized. The Connector never copies the Workspace object itself.

Never send:

- `cwd`
- `path`
- `local_path`
- `workspace_path`
- Workspace canonical filesystem paths
- Harness Credentials
- Worker Token

A missing/deleted authorized Workspace is removed from the advertised effective allowlist immediately. The Connector may remain paused until stale local authorization is corrected, preserving the existing fail-closed behavior.

## Cloud ownership

Cloud should persist the advertised Workspace set under the authenticated paired device identity and its ChatGPT Site owner. A global `worker_id` string is display/routing metadata, not the sole ownership key.

`list_authorized_workspaces` must query only devices belonging to the current Site user and return only safe device/presence metadata plus Workspace ID/name.

## Submit preflight

For `route=local`, Cloud must validate the requested Workspace against the current user's paired device Workspace set before creating a task. Invalid Workspace requests fail before queue insertion.

Local Connector validation remains the second security boundary: `workspaceForTask()` plus `ctx.workspaceRegistry.get(workspaceId)` must still pass before the Harness Session starts.