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
