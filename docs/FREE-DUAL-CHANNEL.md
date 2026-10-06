# Free Dual Channel Orchestration — 0.7.0

DeepSeek Worker 0.7.0 uses **two free ChatGPT control channels** and does not require an OpenAI API key.

## First principle

The project must remain usable without extra OpenAI API billing.

The active orchestration modes are:

```text
auto | native | bridge
```

The 0.6.0 `cloud` / OpenAI Responses API fallback is retired and must not be called.

## Channel 1 — Native MCP Events

Preferred path when ChatGPT actually establishes an MCP Events subscription.

```text
task.completed / task.failed
        ↓
MCP Events webhook
        ↓
ChatGPT Work/host wakes the same orchestration flow
        ↓
acquire_project_lease
        ↓
read pending event + result
        ↓
submit / continue / retry
        ↓
ack event
        ↓
release lease
```

If the ChatGPT host does not call `events/subscribe`, auto mode uses Chat Bridge.

## Channel 2 — Chat Bridge

Chat Bridge follows the control-plane idea proven by projects such as
`codex-with-chatgpt`: the local executor actively sends a tiny structured
message into a bound ChatGPT conversation.

The message carries no file contents, result body, logs, commands, credentials,
cookies, or local paths.

Example:

```text
[DSW]
STATE: TASK_COMPLETED
PROJECT_ID: project_...
EVENT_ID: evt_...
TASK_ID: task_...
REVISION: 7

ACTION:
Use DeepSeek Worker tools. Acquire the project lease, read pending project
events and the task result, continue/retry/submit only what is needed, ack
handled events, release the lease, then end this turn. Do not poll task status.
```

That normal ChatGPT user turn is the wake-up mechanism. ChatGPT then reads the
real project state/result through the existing DeepSeek Worker MCP tools.

## Local browser model

The Connector launches a dedicated Microsoft Edge / Google Chrome / Chromium
profile for Chat Bridge and connects through the browser's local DevTools
protocol.

Properties:

- Browser debugging is loopback-only.
- The profile lives on the user's machine.
- ChatGPT cookies/session state never go to DeepSeek Worker Cloud.
- Cloud cannot provide a browser executable path or local profile path.
- The Connector only accepts an HTTPS `chatgpt.com` chat/project URL from its
  **local** configuration.
- The Cloud sends only a structured bridge envelope with IDs and event type.
  It cannot send arbitrary prompt text to the browser.
- The local Connector itself renders the fixed `[DSW]` message.
- Successful browser delivery is acknowledged to Cloud with only
  `delivery_id`, `message_key`, success/failure, and a sanitized error.

The dedicated browser profile lets the user log in to ChatGPT once and reuse the
session after Harness/Connector restarts.

## Setup

After updating to Connector 0.7.0:

1. Open **DeepSeek Worker Connector** settings.
2. Keep **Free Chat Bridge** enabled.
3. Paste the ChatGPT conversation URL you want to use as the root controller.
4. Click **Open bridge browser / sign in**.
5. Sign in to ChatGPT in that dedicated browser if needed and open the bound
   conversation.
6. Click **Test bridge browser**.

The full URL stays in local Connector configuration. Production diagnostics
should expose only whether a binding exists and its state, not the URL.

## Auto routing

Default mode is `auto`.

```text
terminal project event
        |
        +-- healthy native subscription?
        |       |
        |       +-- yes -> native first
        |                 |
        |                 +-- acked during grace -> done
        |                 |
        |                 +-- still pending after grace -> bridge
        |
        +-- no -> bridge immediately (when bridge is ready)
```

If neither free channel is ready, the event remains pending. The system must not
fall through to a paid API.

## Delivery and recovery

Normal path:

1. Local Worker sends terminal result/failure.
2. Cloud persists task state and project event.
3. Cloud policy chooses native or bridge.
4. If bridge owns the event, the terminal response contains a structured
   `bridge_delivery`.
5. Connector injects the fixed `[DSW]` message into the bound ChatGPT chat.
6. Connector posts `/api/worker/bridge/ack` with send success/failure.
7. The project event stays pending until ChatGPT itself acquires the project
   lease, handles it and calls `ack_project_event`.

Recovery path:

- Worker register/heartbeat responses may return queued bridge deliveries that
  were not successfully sent.
- This is delivery recovery, not task-state polling.
- Duplicate deliveries use a deterministic `message_key`; the local Connector
  suppresses a duplicate already confirmed in the chat.

## Cloud contract

Worker register/heartbeat request adds:

```json
{
  "chat_bridge_ready": true
}
```

A terminal response or recovery heartbeat can add:

```json
{
  "bridge_delivery": {
    "delivery_id": "bridge_del_...",
    "message_key": "bridge_msg_...",
    "project_id": "project_...",
    "event_id": "evt_...",
    "task_id": "task_...",
    "event_name": "task.completed",
    "project_revision": 7
  }
}
```

or a bounded `bridge_deliveries` array.

Acknowledgement:

```json
POST /api/worker/bridge/ack

{
  "worker_id": "deepseek-worker-windows",
  "delivery_id": "bridge_del_...",
  "message_key": "bridge_msg_...",
  "success": true,
  "error": null
}
```

Cloud must verify owner/worker/delivery relationships before changing delivery
state.

## D1 migration

Apply:

```text
cloud/schema-free-dual-channel.sql
```

0.7.0 uses `project_orchestration_config_v2` with:

```text
auto | native | bridge
```

Existing 0.6.0 `cloud_orchestrator_runs` and related tables may remain for
history, but no new paid Cloud runs are created.

## Diagnostics

`get_orchestration_diagnostics(project_id)` should report:

- mode
- native grace
- pending event count
- native subscription health
- Chat Bridge ready/bound/state
- last bridge event/send/error
- latest bridge delivery state
- `paid_cloud_orchestrator_enabled: false`

Never return:

- ChatGPT cookies
- browser profile data
- full bound chat URL
- OAuth tokens
- Worker token
- whsec secret
- local filesystem paths

## Minimum real-machine acceptance

1. Update local Connector to 0.7.0.
2. Bind one ChatGPT chat in Connector and sign in through the bridge browser.
3. Create a new project in `auto`.
4. Confirm native subscription count is zero.
5. Submit stage 1 and end the current ChatGPT turn.
6. DeepSeek completes stage 1.
7. Connector receives a structured bridge delivery and injects
   `[DSW] STATE: TASK_COMPLETED` into the bound chat.
8. ChatGPT starts a normal turn from that injected message.
9. ChatGPT acquires the project lease, reads pending event/result, submits stage
   2, acks the event and releases the lease.
10. Stage 2 completes and repeats the same flow.

Success means the project advances without OpenAI API billing and without the
user manually sending the follow-up message.
