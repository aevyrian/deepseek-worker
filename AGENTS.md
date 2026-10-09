# Repository maintenance instructions

## Protected public landing page

The user-facing first-contact section of `README.md` is intentionally stable.

Anything between:

```text
<!-- FRONT-PAGE-BEGIN -->
<!-- FRONT-PAGE-END -->
```

must not be rewritten, replaced, moved, expanded, or filled with release notes during routine maintenance.

This rule applies to:

- version bumps
- bug fixes
- feature work
- refactors
- release preparation
- updater changes
- Cloud / pairing / Workspace / Session changes
- automated or AI-generated maintenance

Only edit that protected section when the repository owner explicitly asks to change the public landing page, installation instructions, onboarding flow, or end-user usage.

Do not insert implementation details, architecture notes, CI results, changelog entries, or version-specific engineering notes above `FRONT-PAGE-END`.

Routine release information belongs in `CHANGELOG.md` or the relevant file under `docs/`.

## Product behavior that should remain stable

Do not remove or silently rename the built-in `orchestrator-worker` preset or change the fact that new Worker Native Sessions select it, unless the repository owner explicitly requests that product behavior change.

## Mandatory versioning and update policy (2026-10-09)

**Read and follow [docs/VERSIONING_AND_UPDATE_POLICY.md](docs/VERSIONING_AND_UPDATE_POLICY.md) before any Connector build, version bump, release, installer change, or end-user upgrade.**

- Use `MAJOR.MINOR.PATCH`: small bug fixes and reliability adjustments increment the **last** number (`0.7.13 → 0.7.14`); project feature/phase upgrades increment the **middle** number and reset PATCH (`0.7.13 → 0.8.0`); the first fully accepted formal stable version increments the **first** number (`0.9.x → 1.0.0`), and later incompatible major releases do likewise.
- **Do not upgrade by directly editing or copying the installed plugin source.** This has caused Desktop update-channel errors. To deliver user-facing changes, push the verified build to the trusted `aevyrian/deepseek-worker` GitHub source, create the matching `vX.Y.Z` tag and GitHub Release, and update through the Connector built-in updater or **official** Harness Desktop Plugin Manager.
- Do not confuse installed package version with loaded runtime Build Hash: after an approved install, restart Harness if necessary and verify the loaded fingerprint. Preserve Outbox, config, backups and the Worker drain/idle gate.
- Mark releases **Pre-release** when full real-world E2E has not been validated. Passing mocked tests does not prove multi-conversation Bridge delivery, ChatGPT result reading, or correct Project Event ACK.
- Do not move existing tags or overwrite released SHAs; publish a new patch version instead. Do not bypass the protected README section above.
