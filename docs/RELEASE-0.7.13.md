# 0.7.13 — P0 Reliability Preview (prerelease)

> **Prerelease. NOT a stable release. NO-GO for stable.**
> This build is published as a GitHub **prerelease** only. Real end-to-end acceptance has not been
> validated: no real target-conversation message, no real ChatGPT result consumption and no real
> `ack_project_event` acknowledgement were observed. **A/B end-to-end and ChatGPT ACK are NOT
> validated.** The evidence behind this release is 370/370 simulated tests.

## Release identity

| Field | Value |
| --- | --- |
| Package | `deepseek-worker-connector` |
| Version | `0.7.13` |
| Git tag | `v0.7.13` |
| GitHub Release | prerelease = `true`, draft = `false` |
| Parent (candidate) commit | `3511e1e46ee3d4b5ef7df266820ce58b396e0ab1` |
| Previous stable | `0.7.12` (`5b9f7639de8944cc5940ea24cda795535be113f2`) |

This release contains **no functional change beyond the verified P0 candidate**. Compared with
`3511e1e`, it changes only the version declarations (`package.json`, `lib/update.mjs`), this
changelog entry and this release-notes file. No refactoring, no new features.

## What it fixes

1. **Bootstrap browser health only** — the startup health check is isolated from the bound
   conversation, so bootstrapping the browser can no longer touch, re-target or blank the chat the
   Connector is bound to.
2. **No tab stealing** — target lookup and delivery reconciliation are strictly read-only. They never
   navigate, never insert, never click and never open a tab to search. When the target cannot be
   resolved the path stops with an explicit reason.
3. **`wake_target` as an independent target** — a per-delivery wake target outranks the global
   `chatBridgeChatUrl` instead of being merged with it, and cosmetic URL variants
   (trailing slash, harmless query parameters, `www.` host, `/g/<project>/c/<id>` spelling) resolve
   to the same conversation while a different conversation id, the home page, an auth page or a
   non-HTTPS URL fail closed.
4. **Draft protection** — the blind Enter fallback is removed. When no safe clickable send control
   is found, the verified draft is retained and reported rather than submitted through an unverified
   key event. A draft dropped by a hydration re-render is re-inserted at most three times, and only
   an explicit matching message key in a ready composer permits one bounded safe-draft recovery.
5. **Outbox phase crash recovery** — sanitized delivery-phase diagnostics are persisted and Outbox
   records are extended in place, so a delivery interrupted mid-phase is reconciled after restart
   instead of being blindly resent. Legacy Outbox rows stay readable.
6. **Dedupe, ACK identity and bounded retries** — send and reconcile share one conversation
   identity, a durable short lease prevents concurrent checks, retry is bounded exponential with
   retained failure diagnostics, and Cloud acknowledgement retries independently without resending
   the message.

## Test status

- `node --test tests/*.test.mjs` — **370 pass / 0 fail / 0 skipped** (simulated CDP browser harness,
  with real-process fault injection).
- Real browser acceptance: **not performed**.
- Real target-conversation delivery and ChatGPT result consumption + `ack_project_event`:
  **not verified**.

## Installation

Install through the **official Harness Plugin Manager** only (`dsh plugin --profile desktop`). Do not
copy files into the profile directory by hand and do not point the profile at an unverified tarball.

- The plugin source for this release is the GitHub tag `v0.7.13` (or the exact commit it points to).
- **A Harness restart is required** after installation. The previously loaded Connector generation
  stays in memory until the Harness process restarts; an install alone does not load `0.7.13`.
- Before upgrading, stop or drain running business tasks and keep the existing Connector, profile,
  config and Outbox backup. The Outbox must not be cleared and pending `[DSW]` messages must not be
  resent.
- Rollback target: reinstall `0.7.12` from tag `v0.7.12`.

## Not part of this release

No production Site deployment, no D1 migration, no change to the stable release channel, no
production event creation or acknowledgement, and no historical message cleanup.
