# DeepSeek Worker Connector for DeepSeek Harness

This bundle is prepared against the recovered local source of the existing private `DeepSeek Worker` Site. It is not installed or published. The Site source patch in the companion recovery workspace adds the `/api/worker/*` protocol and migration; those changes are still local and are not live yet.

## Architecture

- Harness is the primary executor. The bundle receives `ctx.sessionController`, resumes the mapped `session_id` or creates one, prompts it, reads the completed Session event, and reports the result.
- The headless `dsh --profile headless --json` path is used only when this profile has no `ctx.sessionController` service.
- The `LOCAL_WORKER_TOKEN` secret is resolved through `ctx.credentials` each time a request is sent. Its value is never written to the bundle, profile manifest, log, or command line.
- A Worker ID must first be paired through the existing authenticated Site MCP tool `register_local_worker`. Then the connector's `/register` call applies its workspace allowlist to that paired Worker.
- `workspaceAllowlist` maps exact Sites `workspace_id` values to local absolute directories. It defaults to empty and fails closed. The Site claim route also filters queued work using the registered workspace IDs.
- Continuations and rework tasks reuse the prior D1 `session_id`; new Sessions send a `session_bound` event so the Site can persist the mapping.

## Install and verify Harness loading now

1. Extract this ZIP to a trusted local folder and leave it there; the Harness profile links to this folder.
2. Keep the default `workspaceAllowlist: {}` for the initial local loading check. With an empty allowlist the plugin logs that it loaded and whether `ctx.sessionController` is available, then pauses before reading credentials or contacting the Site.
3. In PowerShell 7, run:

   ```powershell
   pwsh -NoProfile -File .\install.ps1 -Profile <existing-profile-name>
   pwsh -NoProfile -File .\test-local.ps1 -Profile <existing-profile-name>
   ```

4. Restart the target Harness profile if it is a startup profile. Its log should contain `deepseek-worker-connector loaded` and report whether the native Session Controller is available. With the default empty allowlist, it should then say it is paused safely and make no Site requests.

The Harness bundle command follows the official local install form `dsh plugin --profile <name> add <bundle-folder>`. The installer changes only the named local Harness profile.

## Enable task processing after the Site patch is deployed

The current online Site does not have these `/api/worker/*` routes yet. After the Site patch is reviewed and its publication is separately authorized:

1. Edit `dsh.bundle.patch.yml`. Replace `deepseek-worker-windows` with the Worker ID you pair in the Site MCP. Add exact workspace IDs and allowed local absolute directories. Example:

   ```yaml
   workspaceAllowlist:
     "workspace-id-from-harness": "E:/Projects/allowed-repository"
   ```

2. In the target Harness profile's credential settings, add `LOCAL_WORKER_TOKEN`. Do not put the secret into this YAML file or logs. It must be the same random value configured as the Site runtime secret; use at least 32 characters.
3. Pair the selected Worker ID once through the authenticated Site MCP tool `register_local_worker`.
4. Restart the Harness profile. Check for a successful registration log. The token itself must never appear in logs.

## Local checks

Run `./test-local.ps1` for bundle metadata, JavaScript syntax, and protocol tests. After installation, pass the same profile name to also confirm the profile manifest includes this bundle:

```powershell
./test-local.ps1 -Profile <existing-profile-name>
```

The script does not contact the Site, write D1, configure secrets, or modify Harness profiles. Full validation after the Site update is: submit one local task with an allowlisted `workspace_id`, observe the same Harness Session receive the prompt, and confirm the result, `session_id`, event history, and Worker heartbeat in Site MCP/D1.

## Bundle contents

- `package.json` declares this as a native Harness bundle.
- `dsh.bundle.patch.yml` installs the plugin row.
- `index.js` implements the background connector with `ctx.credentials` and `ctx.sessionController`.
- `lib/protocol.mjs` implements safe config validation, workspace enforcement, request framing, and response parsing.
- `install.ps1` and `test-local.ps1` provide local installation and checks.
- `site-patch/` in the companion recovery workspace contains the Worker API source and D1 migration to review before a later Site publication.
