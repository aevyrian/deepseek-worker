# Cloud Event Loop — 0.5.x

Status: **implementation core in repository; production Site deployment still required**.

This document defines the production contract for turning DeepSeek Worker from a polling workflow into an event-driven orchestration loop.

Official OpenAI reference:

- https://developers.openai.com/plugins/build/mcp-events
- MCP protocol version required by ChatGPT events: `2026-07-28`
- Supported ChatGPT surface: Work chats on web, and Work + Cloud in the desktop app.

## Goal

The orchestrator must not keep one model turn alive while local Harness tasks run.

Desired lifecycle:

```text
User asks for a project
  -> ChatGPT orchestrator creates Project State
  -> ChatGPT submits many independent tasks
  -> current ChatGPT turn ends

Local Connector/Harness runs tasks concurrently
  -> one task finishes
  -> Cloud records terminal task state
  -> Cloud creates task.completed/task.failed event
  -> Cloud delivers the event to the subscribed ChatGPT callback

ChatGPT is reactivated in the subscribed Work chat
  -> acquires project orchestration lease
  -> reads Project State + pending events + full task result when needed
  -> continues useful sessions and/or submits new tasks
  -> acknowledges handled events
  -> releases lease
  -> current ChatGPT turn ends

Repeat until project acceptance criteria pass.
```

The project is therefore a durable state machine, not one long conversation turn.

## Event catalog

Initial production events:

### task.completed

Filter:

```json
{ "project_id": "project_..." }
```

Payload:

```json
{
  "project_id": "project_...",
  "task_id": "task_...",
  "status": "completed",
  "summary": "Short status only.",
  "result_available": true,
  "project_revision": 17
}
```

### task.failed

Same filter and payload shape, with `status=failed`.

Large results MUST NOT be embedded in the webhook payload. The orchestrator calls `read_result` or `get_task` after wake-up.

A future `task.stalled` event may be added once the production Site has a reliable scheduled watchdog. It is not required for the first end-to-end event loop.

## MCP 2.0 discovery

The production MCP endpoint must advertise:

```json
{
  "resultType": "complete",
  "supportedVersions": ["2026-07-28"],
  "capabilities": {
    "tools": {},
    "events": {}
  }
}
```

Existing tools remain available and backward compatible.

The same authenticated MCP endpoint implements:

- `events/list`
- `events/subscribe`
- `events/unsubscribe`

## Subscription identity and authorization

A subscription is scoped to:

- authenticated Site principal
- callback URL
- event name
- canonicalized event arguments

The deterministic subscription ID must not change merely because JSON object keys arrive in a different order.

Before accepting a subscription:

1. Verify the authenticated principal owns the selected project.
2. Validate the event name and arguments.
3. Require `delivery.mode=webhook`.
4. Require an HTTPS callback URL.
5. Require a `whsec_` secret that decodes to 24–64 bytes.
6. Block localhost, private, link-local, metadata, and other non-public destinations after DNS resolution.
7. Do not follow redirects.
8. Send a signed one-time verification challenge and require the exact challenge to be echoed.
9. Only persist/activate the subscription after successful verification.

The repository helper performs structural validation and Standard Webhooks signing. The production Site transport must also validate resolved network addresses on every connection.

## Standard Webhooks

Each verification or event request sends:

- `Content-Type: application/json`
- `webhook-id`
- `webhook-timestamp`
- `webhook-signature`
- `X-MCP-Subscription-Id`

Symmetric signatures use:

```text
HMAC-SHA256(
  webhook-id + "." + webhook-timestamp + "." + exact-request-body,
  base64decode(whsec_...)
)
```

and serialize as:

```text
v1,<base64-signature>
```

The JSON body is serialized once, signed once, and the exact same bytes are sent.

Maximum request body: 256 KiB.

## Callback retries

A `2xx` response acknowledges the event.

Do not retry:

- 410
- 413

Retry other non-2xx or transient delivery errors with bounded exponential backoff.

The same `eventId` is preserved across retries, while the signing timestamp/signature are regenerated for each attempt.

The D1 outbox persists retry state so restarts do not lose events.

## Project State

The production Site adds durable project records.

Minimum state:

```text
Project
  project_id
  owner_key
  goal
  acceptance criteria
  revision
  created_at
  updated_at

ProjectTask
  project_id
  task_id
  role
  status

ProjectEvent
  event_id
  dedupe_key
  task_id
  summary
  project_revision
  acknowledged
```

New MCP tools should expose the minimum orchestration views:

- `create_project`
- `get_project_state`
- `list_project_tasks`
- `list_pending_project_events`
- `ack_project_event`
- `acquire_project_lease`
- `release_project_lease`

Existing `submit_task` gains an optional `project_id` and optional `role`.

Existing clients that do not send `project_id` continue to work exactly as before.

## Project orchestration lease

Several tasks can finish almost simultaneously. Those terminal events can wake multiple orchestrator runs.

Only one run may make project-level scheduling decisions at a time.

Lease semantics:

- one active holder per `project_id`
- finite TTL, normally 60 seconds
- same holder may renew
- a different holder is rejected until expiry
- release is holder-checked
- expired lease may be replaced

The orchestrator reads pending events after acquiring the lease. This lets one run batch several nearly simultaneous task completions into one decision.

## Event deduplication and ordering

Terminal task event identity is deterministic for:

```text
project_id + task_id + terminal_status
```

Repeated worker completion callbacks must not create duplicate project events.

Events may arrive at ChatGPT out of order. The orchestrator therefore treats `project_revision` as state-change evidence and always re-reads current Project State before issuing new work.

Write operations created by event handling must be idempotent.

## D1 tables

See:

```text
cloud/schema-events.sql
```

Tables:

- `projects`
- `project_tasks`
- `project_events`
- `mcp_event_subscriptions`
- `mcp_event_deliveries`
- `project_orchestrator_leases`
- `callback_verifications`

Existing task, pairing, worker, and workspace tables remain untouched.

## Connector relationship

Connector 0.5.0 already supports up to 24 independent outer tasks at once.

Cloud Events do not replace the Connector worker loop. They change only how ChatGPT is notified after a task reaches a terminal state.

The sequence is:

```text
Cloud task queue
  -> Connector claims tasks into bounded pool
  -> independent Native Sessions execute
  -> Connector submits result/failure
  -> Cloud records terminal state
  -> Cloud appends project event
  -> webhook wakes ChatGPT
```

## ChatGPT orchestrator rule

After submitting a useful batch of tasks, the orchestrator should end the current turn.

It should NOT poll every task to completion.

When awakened by a project event:

1. Acquire the project lease.
2. Read pending events.
3. Read current Project State.
4. Read full task results only for relevant completed tasks.
5. Decide which existing sessions need `continue_task`.
6. Submit newly unlocked independent tasks.
7. Acknowledge handled events.
8. Release the lease.
9. End the current turn.

If a task is simply still running, do not wait inside the turn.

## Production rollout

1. Apply `cloud/schema-events.sql` to the Site D1 database.
2. Port `cloud/event-core.mjs` semantics into the production Site server.
3. Port `cloud/webhooks.mjs` signing/verification behavior and use a hardened outbound fetch that validates public resolved addresses.
4. Upgrade `server/discover` to MCP `2026-07-28` with `events` capability.
5. Add `events/list`, `events/subscribe`, `events/unsubscribe`.
6. Add project-state MCP tools while preserving all current task tools.
7. On task result/failure, atomically persist terminal state + project event + delivery rows.
8. Run delivery retries from the Site's supported background execution mechanism.
9. Rescan the Site-associated ChatGPT plugin.
10. Run a real Work-chat subscription test.

## Required end-to-end acceptance

The feature is not accepted until this passes without polling:

1. Create a project.
2. Subscribe a Work chat to `task.completed` for that project.
3. Submit at least 2 independent local tasks.
4. End the ChatGPT turn.
5. Let one local task finish.
6. Confirm Cloud delivers a signed webhook and receives 2xx.
7. Confirm the subscribed Work chat is reactivated automatically.
8. The orchestrator reads the result and submits/continues at least one follow-up task.
9. The reactivated turn ends again without waiting for the remaining tasks.
10. Repeat until the tiny project reaches acceptance.

Only after that test plus a longer real project should the project advance to 1.0.0.
