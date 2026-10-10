# 0.7.14 — Task Notifications and No-Blank Launch Preview (prerelease)

> **Prerelease. NOT a stable release. NO-GO for stable.**
> Real end-to-end acceptance has still not been validated: no real target-conversation message, no
> real ChatGPT result consumption and no real `ack_project_event` acknowledgement were observed.
> The evidence behind this build is 416/416 simulated tests.

## Release identity

| Field | Value |
| --- | --- |
| Package | `deepseek-worker-connector` |
| Version | `0.7.14` |
| Based on | `0.7.13` (`70acb74051a7d5c649c15abf08f2d3e4f734e76a`) |
| Previous stable | `0.7.12` (`5b9f7639de8944cc5940ea24cda795535be113f2`) |

## Changes since 0.7.13

| Change | Source commit |
| --- | --- |
| Durable local task-completion notifications | `caf3dba55e0f44629401b5c85e8fbf72f8abe6ba` |
| Save binding action and task-notification centre UI | `fbb4b750d9e9c9a6185292d6d6ce835b5404643d` |
| CDP browser starts on the ChatGPT home page, never `about:blank` | `2315883d2fd3c9f20abc8826a6c8ce312e533d75` |

All 0.7.13 P0 reliability behaviour is unchanged.

## Test status

- `node --test tests/*.test.mjs` — **416 pass / 0 fail / 0 skipped** (0.7.13: 370).
- Real browser acceptance, real target-conversation delivery, ChatGPT result consumption and
  `ack_project_event`: **not verified**.

## Deferred

- `6c19df6` (wake on ready without a global binding) — semantic conflict with the 0.7.13 bootstrap;
  to be re-implemented separately.
- Uncommitted tab-isolation work is not included.

## Installation and rollback

Install only through the official Harness Plugin Manager (`dsh plugin --profile desktop`) from the
matching tag once it exists; a Harness restart is required. Keep the Connector, profile, config and
Outbox backup; do not clear the Outbox or resend pending `[DSW]` messages. Rollback target: `v0.7.13`
(prerelease) or `v0.7.12` (last stable).