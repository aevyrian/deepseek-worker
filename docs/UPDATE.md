# Connector Self Update — 0.3.2

## Official Harness API audit

DeepSeek Harness current Plugin Manager exposes:

    ctx.pluginManager.listBundles()
    ctx.pluginManager.installBundle(spec, options)

The CLI and service use the same profile package-operation machinery. Desktop supplies its bundled pnpm invocation through launcher-owned profile context; Connector does not locate or execute pnpm itself.

For an already installed dependency, current installBundle() performs package replacement and reports application=restart-required. It deliberately does not publish a new running package generation. Official Harness tests verify that the previous fiber stays active after replacement.

The manager snapshots profile package.json and pnpm-lock.yaml. Package-operation failure/cancellation and bundle or compatibility validation failure restore those snapshots; restoration is owned by Harness, not Connector file manipulation.

## Source identity

Package:

    deepseek-worker-connector

Trusted repository:

    aevyrian/deepseek-worker

Canonical source:

    https://github.com/aevyrian/deepseek-worker.git

Normal install.ps1 now sends that Git source through official dsh plugin --profile ... add ....

A local/file development install is intentionally not auto-overwritten.

### Installed source evidence

Harness `PluginManager.listBundles()` reports bundle identity, version, enabled/installed state, and patch rows; its supported `BundleInfo` contract does not include an install-source field. The official Plugin Manager service retains the active `profile` object. The updater reads the dependency spec for `deepseek-worker-connector` from that profile's `package.json`, which is the manifest the Plugin Manager uses for its own inventory and package operations.

Only Git/GitHub forms resolving to the exact trusted repository are accepted. If the profile has no dependency spec, or it records a registry, local path, tarball, fork, or other unrecognized source, installation fails closed and the UI gives a one-time instruction to install the exact version through the official Harness Plugin Manager. After that installation, future updater calls read the source spec the same Plugin Manager records. Bundle metadata and profile metadata are cross-checked when both are available; conflicting evidence is rejected. Raw untrusted specs are not shown in public status or error text.

This source check identifies the package manager's recorded install source; it is not a cryptographic attestation of a manually edited local profile. The updater still independently verifies the trusted GitHub release/tag, resolves the exact commit, checks package metadata, waits for Worker Drain, and installs only through the official Plugin Manager.

## Provider chain

Future Cloud manifest:

    GET https://deepseek-worker.sxfdgan.chatgpt.site/api/connector/latest

Allowed shape:

    {
      "version": "0.3.2",
      "channel": "stable",
      "source": "https://github.com/aevyrian/deepseek-worker.git",
      "ref": "v0.3.2",
      "minimumHarnessVersion": "0.2.1",
      "mandatory": false,
      "notes": ""
    }

TODO (Cloud, not part of this release): implement /api/connector/latest.

Until then, Cloud 404/405/501/5xx/network failure falls back to the same repository's GitHub Releases and Tags. A successful but malformed/untrusted Cloud manifest fails closed instead of silently switching provider.

## Ref and package verification

Auto-update never installs a branch name.

Allowed declared ref:

- exact version tag matching v<version>
- exact 40-hex commit SHA

A version tag is resolved through GitHub tag-ref API to its commit SHA, including annotated-tag peeling. The exact commit package.json must match:

- name=deepseek-worker-connector
- manifest version
- dsh.bundle.patch=./dsh.bundle.patch.yml

The final installation spec is:

    https://github.com/aevyrian/deepseek-worker.git#<40-hex-commit>

## Idle drain

Once a newer version passes preflight:

    available
    -> waiting-idle

Worker atomically closes a shared claim gate before waiting. A claim already in flight must finish registration into the active task pool; after the gate closes no other claim can start. The updater then waits until all registered tasks finish their session/lease/result/failure processing:

    waiting-idle
    -> installing

Only then does it call Plugin Manager.

If Plugin Manager explicitly reports `failed` or `cancelled` with `changed: false`, the previous runtime reopens the claim gate. After a successful install, or an ambiguous result that might have changed files, the gate remains closed until Harness restarts. On startup, the Connector compares the installed package version with its loaded version and stays paused when a newer package is installed. The public runtime status also reports a SHA-256 build fingerprint computed once at module load from the package manifest and worker/Bridge/update source files; it does not change if those files are edited while the process is running.

The drain does not cancel active work. Durable Outbox records remain in their existing local store, while queued tasks, leases and pending Project Events remain on Site. A Site Project Event being pending is independent of local Worker activity and is not a reason to block an idle drain.

## Install

Call:

    ctx.pluginManager.installBundle(exactCommitSpec, { enabled: false })

enabled:false is deliberate: this is replacement of an already selected running bundle, so updater does not rewrite bundle selection.

Success requires Harness to report restart-required.

## Restart

No general public third-party plugin API for immediate Desktop relaunch was found in current Harness. Connector therefore reports restart-required and tells the user to close/reopen DeepSeek Harness.

It never invokes process termination commands.

## Persistent data

Package replacement does not own:

- Harness Credentials
- LOCAL_WORKER_TOKEN
- profile config overrides
- Workspace registry
- Session persistence
- pairing identity

Updater has no code path that reads or writes Credential values.

## Check cadence

- startup delay: 20 seconds
- recurring interval: 6 hours
- user Retry / enabling auto-update can request an immediate check
- concurrent checks collapse to one active promise
