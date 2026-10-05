# DeepSeek Worker Connector

DeepSeek Harness 原生本地 Worker Connector：让 ChatGPT 的 DeepSeek Worker Cloud 调度本机 Harness Workspace 中的真实 Session、Agent 与工具。

当前版本：**0.2.1**

## 本版本解决的问题

Windows DeepSeek Harness Desktop 真机已经确认：

- 插件可以正常安装、启用；
- 中文配置页正常；
- `ctx.workspaces` 能列出真实 Workspace；
- Workspace 勾选正常；
- 但 0.1.0-beta.3 的自定义 Host Remote 没有被 Gateway 正确发现，因此 Execution 一直“未知”，`status / generateToken / test` 无法调用。

0.2.1 不再重复修改 Client inject，而是修 Host Remote owner 的注册位置。

## Host Remote：0.2.1 的核心修复

Harness 当前 API Gateway 的 source-mode discovery 会在 Gateway 所在 Host Context 上：

1. 遍历 `ctx.reflect.props` 的 Service；
2. 对每个 service key 调用 `ctx.get(serviceKey)`；
3. 读取 Service 的 `typertRemote` binding；
4. 读取 `@Remote` 方法标记；
5. 将 namespace/method 解析到真实 receiver。

旧实现把 `WorkerControlService` 创建在：

    ctx.inject(["credentials", "workspaceRegistry"], async (scope) => {
      new WorkerControlService(scope, input, runtime)
      ...
    })

这个 child scope 并不是 Gateway 用于普通 direct Remote receiver discovery 的正确 owner。

0.2.1 改为让 Connector Host 插件本身成为正式 Loader entry Service：

    export class WorkerControlService extends TypertRemoteService {
      static inject = ["workspaceRegistry"]
      static Config = Config

      constructor(ctx, config) {
        super(ctx, "deepseekWorkerConnectorControl", {
          namespace: "deepseekWorkerConnector"
        })
        ...
      }
    }

    export default WorkerControlService

因此以下 Service / namespace 现在由 Loader/Host Context 正式注册：

    service key:
    deepseekWorkerConnectorControl

    namespace:
    deepseekWorkerConnector

Browser 继续调用：

    ctx.remote.deepseekWorkerConnector.status()
    ctx.remote.deepseekWorkerConnector.generateToken()
    ctx.remote.deepseekWorkerConnector.test()

Worker polling loop 只是这个 Service 生命周期中的 effect，不再决定 Remote Service 是否存在。

## Client Remote lifecycle

0.1.0-beta.3 已经修复的 Browser fiber inject 保留，不重新改回旧方案：

1. `ctx.remote.$mount(contribution)`
2. UI fiber inject：
   - `remote`
   - `remote.deepseekWorkerConnector`
   - `remote.credentials`
   - `workspaces`
   - `slots`
   - `locale`
3. dispose UI
4. dispose Remote contribution

0.2.1 的修复重点是 Host 侧 Service discovery。

## Harness Workspace

Workspace 架构保持不变。

Browser 继续使用：

    ctx.workspaces.list.getSnapshot()
    ctx.workspaces.list.subscribe(...)

Host 继续使用：

    ctx.workspaceRegistry.list()
    ctx.workspaceRegistry.get(workspaceId)

Connector 配置只保存：

    authorizedWorkspaceIds:
      - workspace-xxx
    trustedWorkspaceMode: true

不保存本地 path map。

Cloud 的 `workspace_id` 仍然直接对应 Harness `WorkspaceId`。

Cloud task 中出现以下本地路径字段仍会被拒绝：

- `cwd`
- `path`
- `workspace_path`
- `local_path`

## Native Session

新任务继续走：

    sessionController.create({ workspaceId })

continue / rework 继续要求：

- Session 属于目标 Workspace；
- Session 可以被 inspect；
- Session 持久化 cwd 与官方 Workspace canonical path 一致；
- 然后 `sessionController.resolveAgent(sessionId)` 恢复原 Agent；
- 不会在恢复失败时静默创建替代 Session。

Prompt 使用 `sessionController.prompt(...)`，完成以本次任务后的 `turn/end` 与 `assistant/message` 为准。

## Trusted Workspace

`trustedWorkspaceMode` 默认 `true`。

在用户明确授权的 Workspace 内，Connector 不额外增加第二层文件只读、Shell 白名单或 Git/build/test 限制。实际能力仍由当前 Harness Profile、permission preset、sandbox、工具审批、Agent/Tool 与操作系统决定。

关闭 Trusted Workspace 时，0.2.1 暂停远程 claim，而不是伪造一个未实现的半权限沙箱。

## Worker Token / Credentials

固定 Credential ref：

    LOCAL_WORKER_TOKEN

Host Worker 自己读取 Secret 时使用 Harness credential provider。

Browser 保存和查询状态使用官方：

    ctx.remote.credentials.describe(["LOCAL_WORKER_TOKEN"])
    ctx.remote.credentials.set("LOCAL_WORKER_TOKEN", value)

官方 Credentials Remote 不返回 Secret；`describe` 只返回 configured/source/writable 等元数据。

0.2.1 改善了错误显示：

- Host Remote 没被 Gateway 发现：
  - `Host Remote 不可用（gateway/...）`
- Gateway 找不到方法/定义：
  - `Gateway service unavailable（gateway/...）`
- Credential Remote 缺失：
  - `Credential Remote 不可用`
- Credential provider 不可用/不可写：
  - `Credential provider 不可写或不可用`
- provider 拒绝写入：
  - `Token 保存失败：Credential provider 拒绝写入`

UI 不再把“生成随机 Token”或 Credential Remote 异常统一显示成“配置保存失败”。

Remote/Provider 原始错误文本不会直接拼到 Token 保存错误中，因此不会把 Token 回显到 UI。

## 状态

配置页显示：

- Connector
- Execution
- Credential
- Cloud
- Worker
- 最后心跳

Execution：

- Host 找到 Session Controller → `Native Harness`
- Host 明确找不到 → `Headless fallback`
- status 尚未返回 → `检测中`
- Host Remote / Gateway 调用失败 → `未知`，并显示具体 Remote 类别

## Cloud

**0.2.1 没有修改 Cloud。**

没有修改：

- ChatGPT Site
- D1
- MCP
- Secrets
- `/api/worker/register`
- `/api/worker/heartbeat`
- `/api/worker/claim`
- `/api/worker/lease/renew`
- `/api/worker/events`
- `/api/worker/result`
- `/api/worker/failure`

注册仍将真实 Harness WorkspaceIds 作为现有 `workspace_allowlist` 发送。

## 配置

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

Token 不属于 Config。

## 安装 / 升级

推荐直接重新安装当前 main：

    https://github.com/aevyrian/deepseek-worker.git

升级后：

1. 打开插件配置页。
2. 确认 Harness Workspace“项目”仍可见并勾选。
3. 点击“生成随机 Token”。
4. 保存 Token。
5. 确认 Credential 显示“已配置”。
6. 点击“测试连接”。
7. 确认 Execution 是否显示 `Native Harness`。
8. 再做真实本地任务与续作测试。

## 自动测试

0.2.1 在 GitHub Actions 的 **windows-latest / Node 22** 上执行：

- `node --check index.js`
- `node --check client.js`
- `node --check lib/connector-config.mjs`
- `node --check lib/protocol.mjs`
- `node --check lib/native-session.mjs`
- `npm test`

结果：

    28 tests
    28 pass
    0 fail

新增覆盖包括：

- 真实 `index.js` / `WorkerControlService` Loader-root 注册；
- 按 Harness Gateway 当前算法执行 Host source-mode discovery；
- `deepseekWorkerConnector/status` 可发现并调用；
- `deepseekWorkerConnector/generateToken` 可发现并调用；
- `deepseekWorkerConnector/test` 可发现并调用；
- Client Host Remote 错误分类；
- Credentials describe/set 错误分类；
- Credential 写入失败绝不回显 Token。

其余 WorkspaceId、Native Session、continue/rework、Cloud path 拒绝、Secret 脱敏测试继续保留。

## 真机仍需验证

自动测试之后仍需要 Windows DeepSeek Harness Desktop 实机确认：

- 安装/升级 0.2.1 后插件能正常启用；
- Execution 从“未知”变为 `Native Harness`；
- “生成随机 Token”能够真实返回一次性 Token；
- 保存 Token 后 Credential 显示“已配置”；
- 重开页面后无法读回 Token 明文；
- “测试连接”能进入 Host `test()`，不再出现 Gateway service unavailable；
- register / heartbeat / claim 真实链路；
- 新任务在勾选的“项目”Workspace 创建 Session；
- continue / rework 恢复同一 Session；
- Trusted Workspace 下文件、Shell、Git、build、test 权限符合当前 Harness Profile。

详细实现见 `docs/DESIGN.md`。
