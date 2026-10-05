# DeepSeek Worker Connector 设计思路

本文档记录 beta.2 的架构边界、配置 UI、Host / Browser 分工与安全原则。

## 1. 三层架构

```text
GPT / ChatGPT
负责理解目标、拆任务、验收
        │
        ▼
DeepSeek Worker Cloud
MCP / D1 / Cloud DeepSeek / Task Router
        │
        │ HTTPS + Bearer Worker Protocol
        ▼
DeepSeek Worker Connector
DeepSeek Harness Host + Browser Client
        │
        ▼
DeepSeek Harness Local
Session / Agent / Tools / Files / Shell / Git
```

Cloud 和 Local 保持独立部署。本仓库只维护本地 Connector，不修改 ChatGPT Site、D1 或云端 Worker API。

## 2. 为什么仍然是 Harness 插件

旧式独立 Worker：

```text
node worker.js
   ↓
轮询 Cloud
   ↓
spawn dsh headless
```

会把 Session 生命周期放在 Harness 外面，continue / rework 很难自然恢复原会话。

当前架构：

```text
DeepSeek Harness
   └─ DeepSeek Worker Connector
       ├─ Credentials
       ├─ Config / Volatile
       ├─ Session Controller
       ├─ Worker Protocol
       ├─ Typert Remote
       └─ Browser Config UI
```

插件跟随 Harness profile 生命周期，原生 Session 是主路径，headless 仅作为兼容 fallback。

## 3. beta.2 Browser Client

外部 Git Bundle 按 Harness 官方 Client Module 方式提供 Browser half：

```text
package.json
  exports["./client"] = "./client.js"
  dsh.client.platform = "web"
```

`client.js` 是预构建的 lazy-CJS Client Module：

```text
window.__ModuleLoader__.load(...)
```

因此从 Git URL 安装后不要求用户手工执行 npm build。

配置入口注册在：

```text
plugins.row.config
```

key：

```text
deepseek-worker-connector#deepseek-worker-connector
```

Browser UI 复用 Harness 提供的 React 与 UI primitives，包括 Button、Input、Switch 和 StateDot。

## 4. Config 与 volatile

Host 导出 Harness `Config` schema。

以下字段是 volatile：

- endpoint
- workerId
- workspaceAllowlist
- pollIntervalMs
- heartbeatIntervalMs
- leaseRenewIntervalMs
- leaseWaitTimeoutMs
- enableHeadlessFallback
- headlessCommand
- headlessArgs

Browser 通过插件管理器传入的 `form.state` / `form.mutate()` 写入配置。

Worker loop 不缓存一份永久配置，而是在每轮重新读取 volatile 值。这样可以在不重新安装插件的情况下改变连接与 Workspace。

为了避免任务执行中途改变安全边界，一个已领取任务使用开始执行时的 normalized config 快照。

Endpoint / Worker ID / Workspace / Token 改变时，下一轮会重新执行 register。

## 5. Workspace 安全边界

Cloud 只拥有逻辑 ID：

```text
workspace_id = novel
```

Local Connector 保存：

```text
novel → E:\项目\deep
```

验证在两侧执行：

Browser：

- ID 非空
- 不允许重复
- 必须是 Windows / POSIX 绝对路径

Host：

- 再次校验 ID
- 再次校验绝对路径
- 归一化 Windows / POSIX 路径
- task 的 workspace_id 必须精确命中 allowlist

Cloud 永远不能通过 task payload 提供新的本地绝对路径。

默认 allowlist：

```yaml
{}
```

为空时 Worker 保持 loop 存活但状态为 `paused`，不 register / claim；用户添加 Workspace 后自动恢复。

## 6. Credential 模型

固定 Credential ref：

```text
LOCAL_WORKER_TOKEN
```

Host 执行 Cloud 请求前使用：

```text
ctx.credentials.resolve(LOCAL_WORKER_TOKEN)
```

Browser 只使用 Credentials Remote：

```text
ctx.remote.credentials.describe([LOCAL_WORKER_TOKEN])
ctx.remote.credentials.set(LOCAL_WORKER_TOKEN, value)
```

`describe` 的 CredentialInfo 只有：

- configured
- source
- writable

没有 Secret value 字段。

因此已保存 Token 不存在从 Host Credentials “读回 Browser”这条路径。

## 7. 随机 Token

“生成随机 Token”在 Host 使用 Node `crypto.randomBytes(32)`，输出 64 位 hex。

这是唯一允许明文 Token 从 Host → Browser 的情况：它是刚刚生成、尚未保存的新 Token。

Browser 只把该值放在 React 临时 state：

1. 显示一次
2. 允许复制
3. 允许调用 `credentials.set`
4. 保存成功后立即清空
5. 页面离开后不持久化

不会写入 Local Storage、URL、Harness Config 或 Git。

## 8. Host → Browser Remote

运行状态、测试连接与随机 Token 生成属于 Host 权限，因此不在 Browser 直接执行。

Connector 使用 Harness 的 Typert Remote seam 暴露三个无业务入参方法：

```text
deepseekWorkerConnector.status()
deepseekWorkerConnector.generateToken()
deepseekWorkerConnector.test()
```

Host Service 继承 `TypertRemoteService`，方法使用官方 `Remote` marker。

Browser 通过 `ctx.remote.$mount()` 挂载对应 contribution。

状态返回对象只有：

```text
connector
execution
credential
cloud
worker
lastHeartbeat
workerId
workspaceCount
lastError
```

不存在 Token 字段。

## 9. 连接测试

测试逻辑只在用户点击按钮时执行：

```text
validate config
    ↓
workspace count > 0
    ↓
Host resolve LOCAL_WORKER_TOKEN
    ↓
POST /api/worker/register
    ↓
map result to Chinese status
```

没有新增 Cloud health API。

错误分类：

- HTTP 401 → Cloud Token 缺失或 Token 不匹配
- HTTP 403 + pairing code → Worker 尚未配对
- HTTP 403 → Worker 未授权或 Workspace 不允许
- fetch / DNS / refused / timeout → network
- certificate / TLS / SSL → TLS error

如果 Cloud 返回可识别的配对错误 code，UI 给出 MCP `register_local_worker` 提示；无法细分的 403 不会被伪装成已配对。

## 10. Session Controller 状态

Connector 每轮重新查询当前 Cordis `sessionController` Service。

存在：

```text
Native Harness
```

不存在：

```text
Headless fallback
```

页面明确区分二者。

执行任务时也重新读取当前 Session Controller，而不是只在插件启动时决定一次。

## 11. Worker 生命周期

beta.1 在空 Workspace 时会直接退出 worker loop。

beta.2 改为：

```text
loop
 ├─ read current volatile config
 ├─ workspace empty → paused → sleep → retry
 ├─ resolve credential
 ├─ register when identity/config/token changed
 ├─ heartbeat
 ├─ claim
 └─ task → lease → Session → result/failure
```

因此 UI 添加 Workspace 或修改 Endpoint 后不需要重新安装插件。

## 12. Secret 日志策略

所有错误进入日志前调用 redaction：

- 当前 Token 明文替换为 `[REDACTED]`
- 任意 `Bearer ...` 模式替换为 `Bearer [REDACTED]`

Cloud 错误 body 不直接拼进日志或 UI。协议层最多提取一个短的错误 code / message 用于分类。

## 13. Browser 不能直接请求 Cloud

这是 beta.2 的关键边界：

```text
Browser
  ├─ config form
  ├─ credential describe/set
  ├─ status
  └─ test button
       │
       ▼ Typert Remote
Host
  ├─ credential resolve
  ├─ Cloud fetch + Bearer
  └─ worker lifecycle
```

Browser 永远不需要已保存 Bearer Token。

## 14. Session 绑定

Cloud task 与 Harness Session 继续显式绑定：

```text
task_123
   ↕
session_abc
```

首次任务创建 Session 并回传 Session ID。

continue / rework 若带已有 Session ID，Native 路径恢复原 Session。

headless fallback 不会假装安全恢复既有 Session；收到已有 Session ID 时会明确失败。

## 15. Worker 协议

既有协议保持不变：

```text
POST /api/worker/register
POST /api/worker/heartbeat
POST /api/worker/claim
POST /api/worker/lease/renew
POST /api/worker/events
POST /api/worker/result
POST /api/worker/failure
```

认证：

```text
Authorization: Bearer <LOCAL_WORKER_TOKEN>
```

本机不开放公网监听端口。

## 16. 测试边界

仓库测试验证：

- Workspace ID / absolute path / duplicate
- HTTPS endpoint
- fail closed
- token 32-byte entropy → 64 hex
- public status 不包含 Secret
- config snapshot 不序列化 Token
- Secret / Authorization redaction
- 401 / 403 / pairing mapping
- network / TLS mapping
- Native / Headless 区分
- Worker 请求协议

Node `--check` 验证 Host 和预构建 Browser 文件的 JavaScript 语法。

这些都不是 Windows Desktop 真机证明。

仍需真机验证：

- Git installer 的 dependency resolution
- `dsh.client` 激活
- `plugins.row.config` 入口
- Credentials Remote
- Typert Remote mount
- Native Session Controller
- 实际 Cloud register / heartbeat / claim
- 真实任务与 Session 续作

## 17. 版本策略

```text
0.1.0-beta.1   初始 Harness Connector
0.1.0-beta.2   可视化配置、安全 Credential、状态与测试连接
0.1.0          完成 Windows Desktop + Cloud 真机联调后的首个稳定版
```

在 beta 阶段，不把“仓库测试通过”描述成“Cloud ↔ Harness 真机联调成功”。
