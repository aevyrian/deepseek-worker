# P0 来源绑定与宿主事件边界

审查日期：2026-10-09（Asia/Shanghai）。代码基线：`9a24513672c3253cc0381cfec5da6c058b72b6ee`。本报告只读检查 Connector、公开官方文档和既有 Project 的无秘密诊断；没有发消息、创建订阅、获取 lease、ACK 或修改 Site。

## 结论

**任意新聊天 → 自动获知可信可导航 URL → 浏览器原聊天回传，目前没有已验证的通用平台契约。** 当前可执行路径是显式绑定，或在支持的宿主中真实建立 Native MCP Events 订阅。匿名会话关联 ID 不能拼成聊天 URL。浏览器 UI 投递及 webhook 接收均不足以证明 ChatGPT 已读取并处理事件。

## 官方能力与身份

截至审查时，OpenAI 官方说明 MCP Events 支持 ChatGPT 网页 Work、桌面 Work 选择 Cloud，以及 dots；要求 MCP `2026-07-28`。宿主调用 `events/subscribe`、提供 webhook 目的地并验证后，事件可进入订阅聊天。`2xx` 只确认 webhook 接收，宿主异步处理；不能等同业务消费。当前 Codex 本地执行环境的可调用普通工具清单，不能证明该环境建立了原生订阅。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

官方工具调用元数据列出 `openai/session`（匿名会话关联）、`openai/subject`（匿名用户）、`openai/organization`；没有公开的来源聊天可导航 URL 字段。`userAgent` 是可缺失的提示，不能据此可靠识别客户端。**这表示公开契约没有提供该 URL；并不证明所有未公开宿主实现都绝对没有内部信息。** [Plugins Reference](https://developers.openai.com/plugins/reference)

插件可连接多个服务账号，服务授权仍必须根据已认证主体和项目权限检查；ChatGPT 的匿名用户/会话元数据、Site 账号、专用浏览器登录账号需要分别处理。[Authentication](https://developers.openai.com/plugins/build/auth)

| 标识 | 可确认的用途 | 不能据此推出 |
|---|---|---|
| `openai/session` | 同一 ChatGPT session 工具调用关联 | `/c/<id>`、真实账号、跨客户端持久一致性 |
| `openai/subject` / organization | 匿名调用者/组织关联 | 浏览器当前登录账号或对话可访问性 |
| 已认证 Site principal | 项目拥有者及工具授权 | 此 principal 对应哪个浏览器聊天 |
| `project_id` | Worker 状态、任务、事件的持久归属 | 发起任务的浏览器 tab |
| 显式 conversation URL | 浏览器可导航目标 | 浏览器已登录正确账号、所有客户端可主动恢复 |
| CDP target id | 当前浏览器实例中的标签 | 永久会话身份或跨浏览器标签 |
| native subscription id | 已授权事件过滤与 callback 路由 | 浏览器 URL、业务事件已 ACK |

同一历史聊天在浏览器与桌面打开时，可以使用同一显式 URL 标识浏览器目标，但这里没有验证两者提供相同 `openai/session`、分享订阅或同步恢复执行的契约。不得反向根据匿名 session 判断“同一个历史聊天”，也不得依赖另一个客户端打开页面后会自动开始编排。

## 当前代码能证明什么

- `lib/chat-bridge.mjs:normalizeWakeTarget` 接收 `type=chatgpt_conversation`、URL、可选 conversation id、source、captured_at。URL 通过 HTTPS/host/conversation path 检查。`source` 字符串和 `captured_at` 格式检查只是结构校验，不是来源签名或账号证明。
- `normalizeBridgeEnvelope` 接收 Site 提供的 `wake_target`，保留显式 `legacy_binding`。`lib/wake-transport.mjs:cloudEnvelope` 继续传递这些字段；`index.js` 也把 task 的目标传入本地终态通知。`lib/bridge-outbox.mjs` 对同一 message key 的冲突目标拒绝更新。
- `conversationIdentity` / `sameChatTarget` 使用聊天路径中的 conversation id 比较目标，允许路径外观差异。它们不查询账号身份，不证明该聊天在当前浏览器可访问。
- `cloud/mcp-events.mjs` 先检查项目拥有者，再进行 callback verification，验证成功才持久化订阅。`cloud/orchestration-policy.mjs` 在 auto 模式以订阅健康判断优先路径；手动 native 模式不能作为“实际订阅可用”的证据。
- 当前仓库没有 Site 的 `tools/call` 包装及 `bind_project_conversation` 实现；搜索 Connector / cloud 代码没有 `_meta` 来源捕获处理器。因此本报告不能审计生产 Site 是否捕获 `openai/session`、具体如何建立来源关联或实现绑定不可变性。
- 本会话暴露的 `bind_project_conversation(project_id, conversation_url)` 工具描述声明：只绑定拥有的项目、绑定不可变、不返回 URL。该描述是可用接口契约，不是服务端实现审查或完整恢复流程的证明。

旧 `docs/FREE-DUAL-CHANNEL.md` 的“Cloud 不提供 URL、仅 local config”描述与本基线支持 Site `wake_target` 的代码已不一致。应以精确构建代码和实际 envelope 为证据，避免照旧文档回退到全局旧聊天。

## 只读生产证据

2026-10-09 21:21–21:22（Asia/Shanghai）调用已暴露的 owner-scoped 诊断工具，目标为用户指定事故 Project `project_82b089c1-a02c-4f6c-bdd2-6dab3717616d`：

```json
{
  "events_capability_enabled": true,
  "mcp_protocol_version": "2026-07-28",
  "events_catalog": ["task.completed", "task.failed"],
  "active_subscription_count": 0,
  "subscriptions": [],
  "callback_verifications": [],
  "recent_deliveries": [],
  "events/subscribe": null,
  "events/unsubscribe": null,
  "mode": "bridge",
  "pending_event_count": 1,
  "native_subscription": {
    "healthy": false,
    "reason": "no_active_subscription",
    "active": false
  },
  "bridge_ready": false,
  "latest_bridge_delivery_state": "queued",
  "latest_bridge_delivery_attempts": 0
}
```

`server/discover` 在 `2026-10-08T13:54:42.154Z`、`events/list` 在 `2026-10-08T13:54:42.444Z` 记录成功。以上能证明**该项目在该次诊断时没有活跃订阅**；不能扩大成所有项目永远无订阅，也不能推断无订阅的宿主内部根因。Delivery queued/attempts=0 是 Site 状态，不排除本地 Outbox 的未决提交；没有把它当成“肯定从未写入浏览器”的证据。

## 安全且可恢复的操作流程

以下是发布验收和产品约束；不表示本次已修改 Site 或已经通过真机验收。

1. 在准备实际发起任务的聊天中建立独立 Project。用户明确给出该聊天 URL（复制当前真实地址），不要让模型从匿名 ID、聊天标题、最近标签或全局配置猜测。
2. 用该拥有者的 `bind_project_conversation` 显式绑定。保留成功/冲突结果和项目 ID；只保留必要目标字段，诊断显示目标摘要和绑定状态，不输出 URL、账号秘密或 cookie。调用结果不明确时先读取无秘密绑定/路由状态；如果现有只读接口没有足够信息，就停止下发任务并报告缺口，不能试图换目标修复。
3. 绑定不可变时，重复绑定同一目标应幂等；冲突必须拒绝。**当前没有已验证的解绑/改绑接口**，错误或不可确认绑定的恢复方法是建立新 Project 后明确绑定，保留旧 Project 和未处理事件。禁止迁移旧事件到新聊天或 ACK 掩盖问题。
4. 专用 Bridge 浏览器登录后，只读确认指定会话可访问和目标身份。登录检查不是账号关联证明；需要用户在专用浏览器确认目标属于预期账号。缺登录、目标不可访问、绑定缺失或身份冲突，保留 queued/uncertain 并等待明确操作。Bootstrap 只健康检查。
5. 新建唯一验收任务并冻结目标到持久 Outbox。同一 message key 的恢复保持目标与去重证据；任何来源变化不能替换投递目标。只有目标会话中的真实用户消息可成为 message_visible。
6. 若希望启用 Native，在官方支持的宿主聊天中明确请求监控并实际观察 subscribe + verification + active subscription；建立后再用独立验收任务证明 webhook 接收与 ChatGPT 读取结果/业务 ACK。没有订阅时使用已验收 Bridge，缺双通道时事件继续 pending。
7. 重启或断线后先核对构建、Outbox、同一目标及既有消息。未决消息恢复必须通过 reconcile，禁止盲目重复提交。可访问性恢复后按现有边界重试；超过恢复预算由诊断明确报告人工处理，不回退旧聊天。

## ACK 与实际保证

| 阶段 | 可接受证据 | 含义 |
|---|---|---|
| draft_verified | 指定目标输入框中的本条通知 | 草稿已写入 |
| submit_attempted | 指定目标的发送动作记录 | 结果尚可能不明确 |
| message_visible | 指定目标真实用户气泡 + message key | 浏览器提交已可见 |
| transport_acked | Site bridge delivery ACK 成功 | 通知运输完成 |
| orchestrator_handled | ChatGPT 读取结果、持久化后续决定并 `ack_project_event` | 项目业务事件被消费 |

`WakeTransport.acknowledgeCloudDelivery` 和 `cloud_ack_state` 只管理 Site 通知 ACK。暴露的 `ack_project_event` 契约要求 lease、读取结果、稳定 request key 写入下一批任务后才确认；不能由 Connector 代替。基线 `cloud/event-core.mjs` 的内存 core `acknowledgeEvent` 只是拥有者检查和布尔状态，它不包含完整生产 lease/编排实现，不能拿这个 helper 证明线上事务正确性。

浏览器提交与本地持久化之间没有共享事务，不能承诺端到端 exactly-once。实际目标是持久 message key 去重、提交不明确时 reconcile、只在目标可见后运输 ACK，以及业务阶段的 lease + 幂等 request key。Native/Bridge 同时唤醒也可能重复触发编排，所以业务幂等仍必须保留。全闭环 GO 必须以 ChatGPT 实际读取结果、做出下一步持久决定及业务 ACK 为证据，模拟 CDP 或 Site delivery sent 均不足。
