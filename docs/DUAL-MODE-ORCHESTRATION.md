# Dual-mode Orchestration — 0.5.x

Status: **repository implementation complete; production Site integration/deployment required before real use**.

This architecture keeps the native ChatGPT MCP Events path and adds a Cloud Orchestrator fallback.

## Why dual mode

The production DeepSeek Worker MCP already advertises MCP Events and exposes:

- `task.completed`
- `task.failed`
- Project State
- pending project events
- project orchestration lease
- event acknowledgement

In the current ChatGPT environment, event discovery succeeds but the host has not yet called `events/subscribe`. That means terminal events are persisted correctly, but a Work chat is not always reactivated automatically.

Dual mode avoids blocking the project on that product-layer dependency.

## Modes

Every project has:

```text
orchestration_mode = auto | native | cloud
native_grace_ms    = 30000 by default
```

### native

Use ChatGPT MCP Events only.

Cloud never takes over project scheduling.

### cloud

Use the Cloud Orchestrator immediately for pending project events.

Useful for diagnostics or when the owner deliberately wants fully background execution.

### auto

Default.

1. If there is no active verified MCP Events subscription, Cloud handles the pending event immediately.
2. If there is an active healthy subscription, native ChatGPT gets the first chance to handle it.
3. While the event is younger than `native_grace_ms`, Cloud waits.
4. If the event is still pending after the grace period, Cloud takes over.
5. If callback delivery is expired, dead, repeatedly failing, or otherwise unhealthy, Cloud may take over immediately.
6. Native and Cloud both use the same project orchestration lease, so only one scheduling run may act at a time.

## State machine

```text
DeepSeek task completed/failed
        |
        v
persist terminal task state
        |
        v
persist project event
        |
        +-------------------------------+
        | project mode = native         |
        | -> wait for ChatGPT Events    |
        +-------------------------------+
        |
        +-------------------------------+
        | project mode = cloud          |
        | -> Cloud Orchestrator         |
        +-------------------------------+
        |
        +-------------------------------+
        | project mode = auto           |
        |                               |
        | active healthy subscription?  |
        |    no -> Cloud immediately    |
        |    yes                        |
        |      |                        |
        |      +-> native grace window  |
        |             |                 |
        |             + handled -> done |
        |             + still pending   |
        |                 -> Cloud      |
        +-------------------------------+

Before scheduling:
  acquire project lease

After successful durable scheduling:
  ack project events
  release lease

On failure:
  keep events pending
  release lease
  retry later with the same deterministic run/action idempotency keys
```

## Cloud Orchestrator

The fallback root controller uses the OpenAI Responses API.

OpenAI's current API guidance recommends Responses for new agentic integrations and supports application-owned function tools.

The Cloud Orchestrator deliberately uses **internal function tools** rather than calling the same authenticated DeepSeek Worker MCP endpoint through a remote MCP connection.

Reason:

- The production MCP endpoint is OAuth/user scoped.
- The Site already owns the actual project/task handlers.
- Re-entering the same Site through remote MCP would require forwarding or minting user authorization.
- Internal function tools keep authorization in the existing Site request/project-owner boundary and avoid copying OAuth tokens into the model request.

The model receives only:

- project goal
- acceptance criteria
- project revision
- pending event summaries
- current task graph

It can call these application-owned functions:

- `read_result`
- `submit_task`
- `continue_task`
- `retry_task`
- `request_user_decision`

Lease acquisition, event acknowledgement, authorization and idempotency remain server controlled.

## Root scheduling contract

The Cloud Orchestrator prompt enforces:

- project-level root orchestration, not one long Worker Session
- useful parallelism instead of filler task count
- no polling for running DeepSeek tasks
- avoid parallel writers on the same module/files unless isolated
- parallel investigation/design first
- isolated implementation
- independent testing/review
- integration last
- `continue_task` for exact Session continuity
- `submit_task` for genuinely independent work
- user interruption only for material product decisions, accounts, payments, sensitive credentials, or irreversible destructive actions

## Idempotency

The Cloud run ID is deterministic from:

```text
project_id + sorted pending event IDs
```

Each model action gets a deterministic request key:

```text
orchestrator:<project_id>:<run_id>:<action_index>:<action_name>
```

If OpenAI returns an error after one or more task submissions succeeded:

- the triggering event remains pending
- the project lease is released
- the later retry derives the same run ID
- equivalent actions get the same request keys
- task submission handlers must deduplicate those keys

This prevents recovery from duplicating already-created tasks.

## User decisions

The model does not directly ask the consumer ChatGPT conversation to appear.

If it needs a user decision, it calls `request_user_decision`.

The Site must durably store that question before acknowledging the triggering event.

The project then remains in a user-decision state that ChatGPT can read the next time the user opens the project/chat.

## D1 additions

Apply:

```text
cloud/schema-dual-mode.sql
```

Tables:

- `project_orchestration_config`
- `cloud_orchestrator_runs`
- `project_user_decisions`
- `native_subscription_health`

Existing Project State, event inbox/outbox, task, Worker, pairing and Workspace tables remain unchanged.

## Required Site secrets / env

```text
OPENAI_API_KEY=<Site secret>
ORCHESTRATOR_MODEL=<optional model id>
ORCHESTRATOR_TIMEOUT_MS=90000
ORCHESTRATOR_MAX_ROUNDS=12
```

Current repository default for `ORCHESTRATOR_MODEL` is `gpt-6-astra`, but production should set the model explicitly so changing the orchestrator model does not require a code release.

Never expose `OPENAI_API_KEY` through MCP tools, diagnostics, logs, project state, task context, webhook payloads or model-visible tool output.

## Production integration points

When `task.completed` or `task.failed` is persisted:

1. Persist the Project Event first.
2. Schedule a dual-mode orchestration check.
3. Do not poll Worker task status.
4. Evaluate project mode and native subscription health.
5. If native owns the event, schedule a single grace-expiry check instead of polling.
6. If Cloud owns the event, acquire the project lease and call the Responses API root controller.
7. Persist every Cloud run status.
8. Ack the input events only after all resulting scheduling/user-decision writes are durable.
9. Release the project lease.

A Site background queue/alarm/after-response mechanism may implement the delayed grace check. It should be one scheduled wake-up for the event deadline, not repeated task-state polling.

## MCP admin tools to expose

Production Site should add:

### get_project_orchestration_mode

Input:

```json
{ "project_id": "project_..." }
```

Output:

```json
{
  "project_id": "project_...",
  "mode": "auto",
  "native_grace_ms": 30000
}
```

### set_project_orchestration_mode

Input:

```json
{
  "project_id": "project_...",
  "mode": "auto",
  "native_grace_ms": 30000
}
```

Owner scoped.

### get_orchestration_diagnostics

Owner-scoped, secret-free diagnostics:

- mode
- native grace
- pending event count
- native subscription health/reason
- latest Cloud run ID/status
- fallback reason
- model
- response ID
- input event IDs
- created task IDs
- sanitized error summary
- start/finish timestamps

Do not expose OpenAI API keys, callback URLs, webhook secrets, OAuth tokens or local filesystem paths.

## Acceptance tests

### A. No native subscription

1. Create a project in `auto`.
2. Confirm active native subscription count is zero.
3. Submit a local task.
4. End the interactive turn.
5. Task completes and creates `task.completed`.
6. Cloud immediately acquires the project lease.
7. Cloud Responses orchestrator reads the result and submits a follow-up task.
8. Triggering event is acked.
9. No ChatGPT polling occurs.

Expected fallback reason:

```text
no_active_subscription
```

### B. Native subscription works later

1. Keep the project in `auto`.
2. Establish a real ChatGPT MCP Events subscription.
3. Produce a terminal event.
4. Cloud sees healthy native subscription and waits for the grace window.
5. ChatGPT event handler acquires the project lease and handles/acks the event.
6. Cloud grace wake-up sees no pending event and does nothing.

### C. Native delivery fails

1. Active subscription exists.
2. Callback becomes dead or repeatedly fails.
3. Terminal event stays pending.
4. Auto mode selects Cloud.
5. Cloud finishes scheduling and acks the event.

### D. Race safety

Start native and Cloud handlers together for the same pending event.

Exactly one obtains the project lease and creates follow-up work.

## 1.0.0 gate

Do not release 1.0.0 until:

- Connector 0.5.x concurrency is real-machine accepted
- native MCP Events path works when the ChatGPT host subscribes
- Cloud fallback works without polling
- native/cloud lease race is proven safe
- partial OpenAI/tool failures recover idempotently
- user-decision state is durable
- at least one multi-stage real project completes autonomously
