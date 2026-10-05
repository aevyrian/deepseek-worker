# DeepSeek Worker Connector

DeepSeek Harness 原生本地 Worker Connector：让 ChatGPT 的 DeepSeek Worker Cloud 调度本机 Harness Workspace 中的真实 Session、Agent 与工具。

当前版本：0.1.0-beta.3

## 架构

ChatGPT → DeepSeek Worker Site → HTTPS + Bearer → DeepSeek Worker Connector → DeepSeek Harness Desktop。

本仓库只维护本地 Connector。beta.3 不修改 ChatGPT Site、D1、MCP、Secrets 或任何 /api/worker/* 云端接口。

继续复用已有 Worker API：

- POST /api/worker/register
- POST /api/worker/heartbeat
- POST /api/worker/claim
- POST /api/worker/lease/renew
- POST /api/worker/events
- POST /api/worker/result
- POST /api/worker/failure

## beta.3 重点变化

- 修复 Windows Harness Desktop 中 remote.deepseekWorkerConnector 未声明 inject 的错误。
- 配置页直接读取 Harness 官方 workspaces Client service。
- 用户只勾选已有 Workspace，不再输入 Workspace ID 或本地绝对路径。
- 配置只保存 authorizedWorkspaceIds。
- Cloud 的 workspace_id 现在就是实际 Harness WorkspaceId。
- 新 Native Session 使用 sessionController.create({ workspaceId })。
- continue / rework 必须恢复原 Session，并校验它仍属于请求的 Workspace。
- 增加 trustedWorkspaceMode，默认 true。
- Remote 状态读取失败时显示“检测中 / 未知”，不再误显示 Headless fallback。
- Token 继续只保存在 Harness Credentials。
- Cloud task 即使在 Trusted 模式下也不能注入 cwd、path、workspace_path 或 local_path。

## 安装

在 DeepSeek Harness 插件管理器中添加：

https://github.com/aevyrian/deepseek-worker.git

也可以使用 CLI：

dsh plugin --profile <你的-profile> add https://github.com/aevyrian/deepseek-worker.git

启用 Bundle 后打开：插件 → DeepSeek Worker Connector → deepseek-worker-connector → 配置。

## 推荐使用流程

1. 在 Harness 左侧“工作区”创建项目。
2. 打开 Connector 配置页。
3. 勾选允许 DeepSeek Worker 使用的 Harness Workspace。
4. 配置 Worker Token。
5. 保持“受信任工作区模式”开启。
6. 保存配置。
7. 点击“测试连接”。
8. 从 ChatGPT 创建本地任务。
9. Connector 在对应 Harness Workspace 创建或恢复 Session。

## Harness Workspaces

Browser Client 使用 Harness 官方 ctx.workspaces.list.getSnapshot() 与 subscribe() 读取实时 Workspace 列表。每一项来自官方 WorkspaceView，Connector UI 主要使用 workspaceId 与 title，不要求用户输入或维护本地路径。

配置只保存类似：

    authorizedWorkspaceIds:
      - workspace-xxx
      - workspace-yyy
    trustedWorkspaceMode: true

不再保存自定义 Workspace alias、alias → 本地目录映射或本地绝对路径副本。

如果 Harness 中删除了已授权 Workspace，UI 会从当前草稿移除失效 ID 并提示保存；Host 在持久配置尚未修正前也会 fail closed，不继续领取任务。

## Cloud Workspace 语义

注册 Worker 时继续使用原协议字段 workspace_allowlist，但其中的值现在是真实 Harness WorkspaceId。

Cloud task 的 workspace_id 也必须是真实 WorkspaceId。

Host 收到任务后：

1. 确认 workspace_id 属于 authorizedWorkspaceIds。
2. 通过 ctx.workspaceRegistry.get(workspaceId) 确认 Workspace 当前仍存在。
3. 把官方 Workspace 对象交给本地执行路径。
4. 不自己拼接或接受 Cloud 指定的本地路径。

Connector 明确拒绝 Cloud task 中出现 cwd、path、workspace_path 或 local_path。

## Native Harness Session

新任务使用当前官方 Session Controller：

    sessionController.create({ workspaceId })

Harness 自己解析 Workspace 的 canonical path 并把新 Session 附着到该 Workspace。Connector 不再自己解析项目路径后传 cwd。

如果 Cloud 带已有 session_id，Connector 会先验证：

1. Session ID 仍存在于目标 Workspace 的 sessionIds。
2. sessionController.inspect(sessionId) 能读取该 Session。
3. Session 的持久化 cwd 与当前官方 Workspace canonical path 一致。
4. 再调用 sessionController.resolveAgent(sessionId) 恢复原 Agent。

任一步失败都会显式失败，不会静默创建新 Session。

Prompt 使用 sessionController.prompt(...)。Connector 等待该 Session 的 turn/end，再读取本次任务开始位置之后的最新 assistant/message 作为结果。

## 受信任工作区模式

默认 trustedWorkspaceMode: true。

它的含义是：对用户明确勾选的 Harness Workspace，Connector 自己不再附加一层文件只读、Shell 命令白名单或重复的项目权限限制。

因此，只要当前 Harness Profile / Agent 本身允许，任务可以使用 Harness 已有的文件读写、新建/删除项目文件、Shell、Git、npm/pnpm、build、test、Harness Tools、网络与 Agent/subagent。

仍然由 DeepSeek Harness 与操作系统控制：

- Harness permission preset / sandbox
- Harness 工具审批
- Agent / Tool 自身能力
- 操作系统文件权限
- 网络环境
- 用户安装的插件与工具

Connector 不修改 Harness 核心代码，也不绕过 Harness 自己的权限系统。

Workspace 仍然是唯一项目边界：已授权 Workspace 内不额外收紧 Harness；Workspace 外不接受 Cloud 指定任意主机路径。

关闭 Trusted Workspace 后，beta.3 不伪造一个新的“半权限沙箱”。当前行为是允许测试 Cloud 连接，但后台 Worker 暂停 claim。

## Worker Token

固定 Credential ref 是 LOCAL_WORKER_TOKEN。

Token 继续通过 Harness Credentials 保存。Host 使用 ctx.credentials.resolve；Browser 使用 remote.credentials.describe/set。已保存 Token 只能看到“已配置 / 未配置”，不能从 Browser 读回 Secret。

“生成随机 Token”由 Host 使用 crypto.randomBytes(32)，输出 64 位 hex。刚生成时 Browser 临时显示一次，保存后清空。

Token 不进入 Connector Config、Workspace 配置、Git、URL、Local Storage、status Remote 或日志明文。

## Remote namespace 修复

beta.2 虽然执行了 ctx.remote.$mount(contribution)，但真正读取 ctx.remote.deepseekWorkerConnector 的 UI fiber 没有声明该依赖。

beta.3 按 Harness 官方 Remote lifecycle 改为：

1. ctx.remote.$mount(contribution)
2. 创建 UI fiber，并 inject：
   - remote
   - remote.deepseekWorkerConnector
   - remote.credentials
   - workspaces
   - slots
   - locale
3. UI dispose
4. Remote dispose

所以不是用 try/catch 掩盖 cannot get property ... without inject，而是真正声明依赖。

## Harness 状态

页面显示 Connector、Execution、Credential、Cloud、Worker 和最后心跳。

Execution 规则：

- Host 明确检测到 Session Controller → Native Harness
- Host 明确检测不到 → Headless fallback
- Remote 仍在读取 → 检测中
- Remote 调用失败 → 未知

不会再因为 status Remote 失败而默认显示 Headless。

## 测试连接

按钮先保存当前页面草稿，然后由 Host：

1. 校验配置。
2. 至少确认一个授权 Harness Workspace。
3. 确认所有授权 Workspace 当前仍存在。
4. resolve LOCAL_WORKER_TOKEN。
5. 请求现有 POST /api/worker/register。
6. 把 authorizedWorkspaceIds 作为 workspace_allowlist 报给 Cloud。
7. 返回脱敏 Cloud / Worker 状态。

Browser 不直接拿 Bearer Token 请求 Cloud。

## 后台 Worker

- 无授权 Workspace → paused
- 授权 Workspace 已被删除 → paused
- trustedWorkspaceMode = false → paused
- 有 Workspace 但无 Token → paused
- Token + 有效授权 Workspace + Trusted → register → heartbeat → claim → WorkspaceId 验证 → Native Session / Headless fallback → result / failure

## Headless fallback

Headless 仍是最后 fallback，不是主设计。

如果 Native Session Controller 不存在，Connector 只从 Harness Workspace Registry 的官方 Workspace 对象读取 canonical path，并把这个官方 path 用作 headless CLI 的 cwd；不会重新引入用户维护的路径 map。

如果任务带已有 Session ID，而 generic headless 无法安全恢复原 Harness Session，则明确失败。

## beta.3 配置字段

    endpoint: https://deepseek-worker.sxfdgan.chatgpt.site/api/worker
    workerId: deepseek-worker-windows
    authorizedWorkspaceIds: []
    trustedWorkspaceMode: true
    pollIntervalMs: 4000
    heartbeatIntervalMs: 20000
    leaseRenewIntervalMs: 20000
    leaseWaitTimeoutMs: 1800000
    enableHeadlessFallback: true
    headlessCommand: dsh
    headlessArgs: [--profile, headless, --json]

所有非 Secret 字段继续通过 Harness Config / volatile 机制更新。

## beta.2 → beta.3

建议升级步骤：

1. 在 Harness 插件页禁用并卸载 beta.2。
2. 重新从 Git URL 安装本仓库。
3. 启用 Connector。
4. 打开配置页。
5. 确认 Token 是否显示“已配置”；如没有则重新设置。
6. 在 Harness Workspaces 中重新勾选允许的 Workspace。
7. 保持“受信任工作区模式”开启，除非你希望暂停本地任务领取。
8. 保存配置。
9. 点击“测试连接”。

旧 beta.2 手工路径映射不会自动转换，因为 beta.3 的授权对象是 Harness 已存在的 WorkspaceId，而不是路径 alias。

## 自动测试

beta.3 自动测试覆盖 Remote lifecycle、status/generateToken/test、Workspace 列表与选择、失效 Workspace 清理、Token 不进入 Config、Cloud path 拒绝、Native WorkspaceId create、continue Workspace 一致性、401/403/Network/TLS 与原有 Worker protocol。

GitHub Actions 在 Node 22 上执行：

- node --check index.js
- node --check client.js
- node --check lib/connector-config.mjs
- node --check lib/protocol.mjs
- node --check lib/native-session.mjs
- npm test

当前结果：

    24 tests
    24 pass
    0 fail

## 仍需 Windows Desktop 真机验证

自动测试不能替代：

- Git URL 安装 / 升级 beta.3。
- 当前 Windows Desktop 是否加载新的 client.js。
- 配置页是否实时列出真实 Harness Workspace。
- “生成随机 Token”是否不再出现 Remote inject 错误。
- “测试连接”是否不再出现 Remote inject 错误。
- 当前 profile 是否识别为 Native Harness。
- 真正的 register / heartbeat / claim。
- 新任务是否在勾选 Workspace 创建 Session。
- continue / rework 是否恢复原 Session。
- 文件、Shell、Git、build、test 等权限是否按当前 Harness Profile 实际权限工作。

## 结构

主要文件：

- index.js
- client.js
- lib/connector-config.mjs
- lib/native-session.mjs
- lib/protocol.mjs
- tests/client.test.mjs
- tests/config.test.mjs
- tests/native-session.test.mjs
- tests/protocol.test.mjs
- dsh.bundle.patch.yml
- CHANGELOG.md
- docs/DESIGN.md

详细技术边界见 docs/DESIGN.md。

## License

当前仓库尚未添加开源许可证。
