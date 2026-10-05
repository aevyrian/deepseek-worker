# DeepSeek Worker Connector

DeepSeek Harness 原生本地 Worker Connector。普通用户只需要选择 Harness Workspace，然后点击 **安装并连接 ChatGPT**。

当前版本：**0.3.1**

## 普通用户流程

1. 在 Harness 中创建 Workspace。
2. 安装并启用本 Connector。
3. 勾选允许使用的 Workspace。
4. 点击 **安装并连接 ChatGPT**。
5. Connector 自动保存配置、生成本机 Worker Token，并写入 Harness Credentials。
6. Connector 向现有 Cloud pairing API 发送 **token_hash**，不会发送原始 Token。
7. Connector 打开 Cloud 返回的 HTTPS `approvalUrl`。
8. 页面每约 3 秒检查一次配对状态。
9. Cloud 返回 `paired` 后页面自动显示 **已连接**，并停止高频轮询。

页面重新打开时，如果 Harness Credentials 元数据表明本机已有 Worker Credential，Connector 会自动调用 `pairingStatus()` 恢复 pending / paired 状态；Browser 不读取保存后的 Secret。

## 设备连接 UI

默认页面顶部只显示：

- 设备连接：未连接 / 正在连接 / 等待确认 / 已连接 / 连接失败
- Cloud：在线 / 离线 / 未测试
- Harness：Native Harness / Headless fallback / 检测中 / 未知
- 授权 Workspace 数量
- 最后心跳

按钮：

- 未连接：**安装并连接 ChatGPT**
- 等待确认：**打开连接页面**、**检查状态**
- 已连接：**在 ChatGPT 中打开**、**断开连接**

普通用户不需要理解 Worker Token、Bearer、Credential ref 或 Site Secret。

## Cloud /setup 入口

Connector 不猜测 OpenAI Plugin Directory 的 listing URL。

连接时优先打开 Cloud pairing API 返回的 `approvalUrl`。如果只剩本地已知的 pairing metadata，则使用同一 Cloud origin 的：

    /setup?pair=<pairing-code>

已连接后“在 ChatGPT 中打开”也可以回到同一 Cloud `/setup` 入口。

将来正式 DeepSeek Worker public listing URL 确定后，应由 Cloud `/setup` 页面统一决定：

- 插件未安装 → 引导安装
- 已安装 → 继续授权
- 已配对 → 显示成功 / 打开 ChatGPT

这样 Connector 不需要因为 ChatGPT listing URL 改变而升级。

## 高级 / 诊断

以下功能仍保留，但默认折叠：

- Cloud Endpoint
- Worker ID
- 手动 Worker Token
- 生成随机 Token
- 保存 Token
- Poll interval
- Heartbeat interval
- Lease interval / timeout
- Headless fallback
- 保存配置
- 测试连接
- 配对码诊断

手动 Token 只用于旧 Cloud、开发、诊断或恢复。

## Harness Credentials

Host 使用 Harness 当前官方 Credentials contract：

    ctx.credentials.resolve(ref)
    -> { value, source } | undefined

    ctx.credentials.describe(ref)
    -> { configured, source?, writable }

    ctx.credentials.set(ref, value)
    ctx.credentials.unset(ref)

固定 ref 仍为：

    LOCAL_WORKER_TOKEN

自动配对生成的 Token：

- 只写入 Harness Credentials；
- Browser UI 不读取已保存 Token；
- 不写 Config；
- 不写 Local Storage / Session Storage；
- 不写 URL / Query String；
- 不写日志；
- 不写 Clipboard；
- `/api/pair/start` 只收到 SHA-256 `token_hash`。

## Pairing Host Remote

Connector Host Service 保持：

    service key: deepseekWorkerConnectorControl
    namespace: deepseekWorkerConnector

Browser 调用：

    ctx.remote.deepseekWorkerConnector.beginPairing()
    ctx.remote.deepseekWorkerConnector.pairingStatus()
    ctx.remote.deepseekWorkerConnector.disconnectPairing()

以及已有：

    status()
    generateToken()
    test()

0.3.1 对三个 pairing Remote 使用统一、严格的官方 Credentials shape，并把 Workspace Registry / Credential preflight 的本地失败转换成明确业务结果，避免异常逃出 Host method 后被 Gateway 折叠成 `gateway/internal`。

## Pairing 状态

Connector 识别：

    unpaired
    pending
    paired
    expired
    revoked
    error

pending 时约每 3 秒调用 `pairingStatus()`。

以下状态停止高频 polling：

- paired
- expired
- revoked
- error

## Workspace 与权限

0.3.1 不修改 Workspace 架构：

- Browser 继续读取官方 `ctx.workspaces`。
- Host 继续使用 `ctx.workspaceRegistry`。
- 持久配置继续使用 `authorizedWorkspaceIds`。
- `trustedWorkspaceMode` 保留。
- Native Session 继续使用真实 WorkspaceId。
- continue / rework 继续验证 Session 与 Workspace 一致性。
- Cloud task 中的 `cwd/path/workspace_path/local_path` 继续拒绝。

## Cloud 边界

本版本 **没有修改 Cloud**：

- 不修改 Site；
- 不修改 D1；
- 不修改 MCP；
- 不修改 `/api/worker/*`；
- 不修改现有 Cloud pairing protocol。

Connector 只消费当前 Cloud 返回的 pairing response。

## 安装 / 升级

Git URL：

    https://github.com/aevyrian/deepseek-worker.git

从 0.3.0 升级后建议：

1. 打开 Connector 配置页。
2. 确认真实 Harness Workspace 正常显示。
3. 勾选至少一个 Workspace。
4. 点击 **安装并连接 ChatGPT**。
5. 确认系统浏览器打开 Cloud 提供的连接页面。
6. 完成确认。
7. 等页面自动变为 **已连接**。

## 自动验证

Windows GitHub Actions，`windows-latest` + Node 22：

    node --check index.js
    node --check client.js
    node --check lib/connector-config.mjs
    node --check lib/protocol.mjs
    node --check lib/native-session.mjs
    node --check lib/pairing.mjs
    npm test

最终结果：

    44 tests
    44 pass
    0 fail

覆盖包括：

- Gateway-discovered Host Service 实际调用 `beginPairing / pairingStatus / disconnectPairing`；
- 官方 `resolve() -> { value, source }`；
- pending → paired；
- expired；
- revoked；
- pairing API unavailable；
- Browser 3 秒 polling；
- 页面 reopen 恢复 pending；
- 页面 reopen 识别 paired；
- Token 不进入 Browser 持久数据；
- Token 不进入 URL；
- pair/start 不带原始 Token / Bearer；
- 普通 UI 不出现 Site Secret 指引；
- 高级手动 Token 兼容；
- Workspace / Native Session / Cloud path 拒绝的既有回归测试。
