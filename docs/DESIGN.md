# DeepSeek Worker Connector 0.2.1 设计

本文档记录 0.2.1 的本地 Connector 架构。Cloud Site、D1、MCP 与 /api/worker/* 不属于本轮修改范围。

## 1. 核心边界

系统保持三层：

ChatGPT → DeepSeek Worker Cloud → DeepSeek Harness Connector → Harness Workspace / Session / Agent / Tools。

Cloud 负责任务与租约；Connector 负责本机接入；Harness 负责真实项目执行与权限。

0.2.1 的唯一项目边界是 Harness 官方 Workspace。

## 2. 为什么废弃 Connector 自维护路径映射

beta.2 同时存在 Harness Workspace 与 Connector 自己的 alias/path map，形成两套项目身份：

- Harness 有稳定 WorkspaceId、canonical path、Session membership。
- Connector 又要求用户手工维护 ID → path。

这会重复状态，也让 Session 与 Workspace 关系无法由 Harness 自己保证。

0.2.1 删除功能性的手工路径映射。持久化只保留：

    authorizedWorkspaceIds: string[]
    trustedWorkspaceMode: boolean

本地 path 只在 Host 需要 headless fallback 时，从当前官方 Workspace 对象读取。

## 3. Browser Workspace 来源

Browser 使用 Harness Client service：

    ctx.workspaces

读取面：

    ctx.workspaces.list.getSnapshot()
    ctx.workspaces.list.subscribe(listener)

WorkspaceView 包含 workspaceId、title、path、sessionIds 等官方字段。

UI 只需要 title 与 workspaceId 供用户辨认和授权。path 不作为 Connector 配置值保存，也不上传 Cloud。

## 4. Host Workspace 来源

Host 使用：

    ctx.workspaceRegistry.list()
    ctx.workspaceRegistry.get(workspaceId)

任何已授权 ID 在 register、claim 和 task execution 前都必须仍能由 Workspace Registry 解析。

持久配置中存在但 Registry 已删除的 ID会导致 fail closed。

## 5. Cloud Workspace 语义

现有 Cloud 字段不变：

    workspace_allowlist
    workspace_id

语义改为 Harness 官方 WorkspaceId。

register：

    workspace_allowlist = authorizedWorkspaceIds

task：

    workspace_id = 某个已授权真实 WorkspaceId

Connector 不接受 task 中的 cwd、path、workspace_path、local_path。Trusted 模式不会改变这一点。

## 6. Remote namespace lifecycle

beta.2 的 Browser half 做了 contribution mount，但真正读取 ctx.remote.deepseekWorkerConnector 的 fiber 没声明 remote.deepseekWorkerConnector。

Harness Cordis Remote namespace 是一个 service 依赖；mount 只创建 namespace，不替调用方声明依赖。

0.2.1 生命周期：

1. 外层 Client plugin 只 inject remote。
2. await ctx.remote.$mount(contribution)。
3. 创建业务 UI fiber。
4. UI fiber inject：
   - remote
   - remote.deepseekWorkerConnector
   - remote.credentials
   - workspaces
   - slots
   - locale
5. registerUi 只在该 fiber 中访问 ctx.remote.deepseekWorkerConnector。
6. dispose 时先销毁 UI fiber，再 unmount Remote contribution。

这与 Harness 官方 optional Remote assembly 模式一致。

## 7. Host Remote 注册与 Gateway discovery

0.2.1 的关键修复是 Host Service 的注册位置。

Harness 当前 API Gateway 在自己的 Host Context 上执行 source-mode discovery：

1. 遍历 `ctx.reflect.props` 中的 Cordis Service。
2. 使用 `ctx.get(serviceKey)` 取得当前 Context 可见的 receiver。
3. 读取 receiver 的 `typertRemote`。
4. 比对 namespace。
5. 读取 `remoteMethods(original)` 并匹配 method。
6. 调用前再次通过 service key 取得 receiver。

因此 Remote owner 必须是真正注册到 Loader/Host Service registry 的 Cordis Service，而不是只在某个 dependency inject child scope 临时 new 的对象。

0.2.1 的 Host entry：

    export class WorkerControlService extends TypertRemoteService {
      static inject = ["workspaceRegistry"]
      static Config = Config

      constructor(ctx, input = {}) {
        super(ctx, "deepseekWorkerConnectorControl", {
          namespace: "deepseekWorkerConnector"
        })
        ...
      }
    }

    export default WorkerControlService

对应：

    Cordis service key = deepseekWorkerConnectorControl
    Remote namespace   = deepseekWorkerConnector

`status / generateToken / test` 的 Remote markers 仍由 Typert protocol 的 `Remote` initializer 写到 class prototype，Gateway 的 `remoteMethods()` 可以发现。

Worker polling loop 通过 `ctx.effect(...)` 附着到这个正式 Host Service 生命周期；它不再包住、创建或决定 Remote owner 的注册。

Credentials 不列入 static inject。理由与 Harness 官方 CredentialsController 相同：Remote owner 应保持可发现，业务调用时再通过 `ctx.get("credentials")` 检查 provider。这样 credential provider 缺失会得到可操作错误，而不是使整个 Connector namespace 消失。


## 8. Execution 状态

Host 初始 execution 为 unknown。

只有 Host 实际检查当前 sessionController 后才返回：

- native
- headless

Browser Remote 尚未返回时显示 detecting；调用失败显示 unknown。

不能用 status failure 推断 Session Controller 不存在。

## 9. Native Session：新任务

官方 SessionCreateRequest 支持 workspaceId 或 cwd，二选一。

0.2.1 新任务只使用：

    sessionController.create({ workspaceId })

Harness Session Controller 自己：

1. workspaceRegistry.get(workspaceId)
2. 得到 canonical workspace.path
3. 创建 Session
4. attachSession(sessionId)

因此 Connector 不再为 Native Session 传 cwd。

## 10. Native Session：continue / rework

不能把 create({ sessionId, workspaceId }) 当作 resume，因为官方 create/adopt 路径在持久 Session 不存在时可能创建新身份。

0.2.1 显式拆开：

1. Workspace.sessionIds 必须包含 sessionId。
2. sessionController.inspect(sessionId) 必须成功。
3. Session meta.cwd 必须等于当前 Workspace canonical path。
4. sessionController.resolveAgent(sessionId) 恢复原 Agent。
5. 任一步失败则 task failure。

这样 Session 不存在、Workspace 已删除或 Session/Workspace 不一致都不会静默变成新 Session。

## 11. Prompt 与完成检测

Native Prompt 使用当前官方：

    sessionController.prompt({
      requestId,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }]
    })

Connector 在 prompt 前记录 Session 当前最后 seq，并监听：

- session/event 的 turn/end
- agent/error

收到本次新 turn/end 后，从 baseline 之后最新 assistant/message 的 text block 合并结果。

lease timeout / abort 仍会终止等待。

## 12. Headless fallback

Headless 仅在当前 Host 没有 Session Controller 且 enableHeadlessFallback=true 时使用。

cwd 来源：

    ctx.workspaceRegistry.get(workspaceId).path

这是 Harness 官方 canonical path，不是 Connector 配置中的路径副本。

已有 session_id 仍不允许 generic headless 假装恢复。

## 13. Trusted Workspace

trustedWorkspaceMode 默认 true。

它不是新的 Harness permission preset，也不会修改 Harness 内部授权。

true 的含义：

- 用户必须先显式授权 WorkspaceId。
- Connector 只做 Workspace 边界校验。
- Workspace 内不再增加第二层 read-only / command allowlist。
- 文件、Shell、Git、build、test、网络、Tool、Agent 等是否可用，继承当前 Harness Profile / Agent / Tool 的实际能力。

仍由 Harness / OS 决定：

- sandbox
- permission preset
- approval policy
- Tool policy
- 文件权限
- 网络权限

false 的 0.2.1 行为是暂停远程 claim。原因是 Connector 当前没有独立、可证明正确的“受限 Harness Workspace”权限模型；暂停比制造一个表面安全但语义错误的第二套权限层更可靠。

## 14. Credential

LOCAL_WORKER_TOKEN 不属于 Config。

Host：

    ctx.credentials.resolve("LOCAL_WORKER_TOKEN")

Browser：

    ctx.remote.credentials.describe(...)
    ctx.remote.credentials.set(...)

Browser 只能读取 configured/source/writable，不读取保存后的 Secret。

## 15. Worker loop

每轮读取 volatile config，并动态检查 Workspace Registry 与 Session Controller。

状态机：

- authorizedWorkspaceIds 空 → paused
- 任一授权 Workspace 不存在 → paused
- trustedWorkspaceMode=false → paused
- Token 缺失 → paused
- 满足条件 → register / heartbeat / claim

Endpoint、Worker ID、Workspace IDs 或 Token 改变后 registration signature 改变，下一轮重新 register。

## 16. 测试连接

Host test 顺序：

1. normalize Config。
2. authorizedWorkspaceIds 非空。
3. 所有授权 Workspace 均在 Workspace Registry。
4. resolve Token。
5. POST /api/worker/register。
6. workspace_allowlist 使用真实 WorkspaceIds。
7. 返回脱敏结果。

Browser 不执行 Bearer fetch。

## 17. 安全不变量

- HTTPS only。
- 默认 authorizedWorkspaceIds=[]。
- 无授权 Workspace fail closed。
- 删除的 Workspace fail closed。
- Cloud task path 字段拒绝。
- Trusted 模式不改变 Cloud path 能力。
- Token 不进入 Config / status / Git / Browser 持久状态。
- Secret 与 Bearer 日志脱敏。
- continue 不静默创建替代 Session。
- Connector 不绕过 Harness 核心权限。

## 18. 自动验证

0.2.1 测试拆成：

- host-remote-discovery.test.mjs：加载真实 Host entry，并按 Gateway discovery 结构验证 Service 可发现与三个 Remote 可调用。

- client.test.mjs：Remote mount/inject/dispose、Remote methods、Workspace service、状态 fallback。
- config.test.mjs：WorkspaceId 配置、失效 ID、Token、Secret、Execution 状态。
- native-session.test.mjs：workspaceId create、continue、membership/cwd 校验、assistant result。
- protocol.test.mjs：Cloud WorkspaceId allowlist、path 拒绝、Worker protocol。

GitHub Actions windows-latest / Node 22 结果：

    28 tests
    28 pass
    0 fail

index.js、client.js、connector-config.mjs、protocol.mjs、native-session.mjs 的 node --check 均通过。

## 19. 尚未验证

仍需要 Windows DeepSeek Harness Desktop 真机确认：

- Git 安装与升级。
- client.js 真实加载。
- workspaces Client service 与 UI 订阅。
- Remote namespace inject 修复在 Desktop 生效。
- Credentials 可写。
- Session Controller 实际存在状态。
- register / heartbeat / claim。
- 新 Session 的 Workspace 附着。
- continue / rework。
- Trusted Workspace 下真实文件、Shell、Git、build、test 能力。

这些项目用于确认 0.2.1 在真实 Windows DeepSeek Harness Desktop 上完成闭环。
