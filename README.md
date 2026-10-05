# DeepSeek Worker Connector

> 让 ChatGPT 的云端 DeepSeek Worker 与本机 DeepSeek Harness 直接协同工作的 Harness 原生连接插件。

本仓库是 **DeepSeek Worker 系统的本地端组件**。它不是云端 MCP Site，也不是独立常驻的 Node Worker。

项目目标是把 DeepSeek Harness 本身变成一个可被云端调度的执行节点：ChatGPT 负责规划、调度和验收，云端 DeepSeek Worker 负责任务编排与持久化，本机 DeepSeek Harness 负责真实项目、文件、Shell、Git 和本地工具执行。

## 项目定位

整个系统由两个彼此独立、通过协议连接的组件组成：

```text
ChatGPT
   │
   ▼
DeepSeek Worker Site
MCP / D1 / Cloud DeepSeek / Task Router
   │
   │ HTTPS + Bearer Worker Protocol
   ▼
DeepSeek Worker Connector
本仓库
   │
   ▼
DeepSeek Harness
Session / Agent / Tools / Files / Shell / Git
```

- **云端组件**：由 ChatGPT Sites 托管，负责任务、状态、上下文、D1、Cloud DeepSeek 和本地 Worker 调度。
- **本地组件**：本仓库中的 Harness 插件，负责把本机 DeepSeek Harness 接入云端。
- **两者独立维护**：云端 Site 更新不会覆盖本地插件，本地插件更新也不需要重新创建 Site。

## 为什么做成 Harness 插件

最初方案是单独运行一个 `worker.js`，不断轮询云端，再通过 `dsh --profile headless` 启动任务。

现在改成 Harness 原生插件，主要原因是：

1. **直接复用 Harness Session**：任务可以绑定 `task_id ↔ session_id`，continue / rework 能继续原会话。
2. **直接复用 Harness 能力**：本地文件、Shell、Git、工具系统、模型和 Session 生命周期都由 Harness 自己管理。
3. **更少的外围进程**：不需要额外常驻一个独立 Node Worker。
4. **更容易升级和回滚**：源码固定在 GitHub，通过 Git 地址安装和更新。
5. **权限边界更清晰**：云端只知道 `workspace_id`，本机插件再映射到允许访问的目录。

详细设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 当前能力

当前 Connector 已包含：

- Harness Bundle 元数据与 `dsh.bundle.patch.yml`
- `ctx.credentials` 读取本地 Worker Token
- 优先使用 `ctx.sessionController` 执行任务
- `task_id ↔ session_id` 续作设计
- `workspaceAllowlist` 本地目录白名单
- Worker 注册、心跳、领取、租约续期、事件、结果和失败回传协议
- HTTPS 出站连接，不要求本机开放公网端口
- Secret 日志脱敏
- Harness Session 不可用时的 headless CLI fallback
- 本地协议测试与安装脚本

## 当前状态

仓库版本：**0.1.0-beta.1**

需要特别说明：

- 本仓库已经包含本地 Connector。
- 当前线上 DeepSeek Worker Site 的稳定版本仍是旧 Worker 架构。
- Connector 所需的 `/api/worker/*` 云端路由和对应 D1 新字段尚未正式部署。
- 因此现在可以安装、检查 Bundle，但完整 Cloud ↔ Harness 任务闭环要等云端 Site Patch 发布后才能启用。

## 安装

DeepSeek Harness 官方插件管理器支持 Git 地址。

### Harness 插件页面

在 **Plugins / 添加插件** 中填入：

```text
https://github.com/aevyrian/deepseek-worker.git
```

安装后启用该 Bundle。

### CLI

```powershell
dsh plugin --profile <你的-profile> add https://github.com/aevyrian/deepseek-worker.git
```

也可以克隆仓库后从本地目录安装：

```powershell
git clone https://github.com/aevyrian/deepseek-worker.git
cd deepseek-worker
pwsh -NoProfile -File .\install.ps1 -Profile <你的-profile>
```

> Harness 当前插件升级机制仍以“卸载旧版本后重新安装”为主。正式使用后建议按 Git tag 固定稳定版本。

## 配置

默认配置位于 `dsh.bundle.patch.yml`。

Workspace 白名单示例：

```yaml
workspaceAllowlist:
  novel: "E:/项目/deep"
  douyin: "E:/项目/douyin-download-manager"
```

云端任务只传：

```text
workspace_id = "novel"
```

本地再解析为真实路径。云端不能直接指定任意 `C:\` 或 `E:\` 路径。

### 凭据

Worker Token 通过 Harness credentials 能力读取：

```text
LOCAL_WORKER_TOKEN
```

不要把 Token 写进 GitHub、bundle patch、README、日志或命令行。

## 执行模式

优先使用：

```text
ctx.sessionController
```

如果当前 profile 没有该服务，才使用：

```text
dsh --profile headless --json
```

headless 只是兼容 fallback，不是主路径。

## 任务生命周期

```text
云端创建任务
    ↓
Connector claim
    ↓
校验 workspace_id
    ↓
创建或恢复 Harness Session
    ↓
执行任务
    ↓
保持 lease
    ↓
回传 result / failure
    ↓
云端保存 session_id
    ↓
continue / rework
    ↓
恢复同一 Session
```

## 安全原则

- 只允许 HTTPS Worker Endpoint
- 本机只主动出站，不开放公网监听端口
- Workspace 默认空白名单并 fail closed
- Cloud 不能传任意绝对路径
- Token 由 `ctx.credentials` 提供
- Authorization 和 Secret 做日志脱敏
- 本地 Harness 插件属于高权限 Host 代码，安装前应确认来源
- destructive 操作继续受 Harness 本身的工具权限约束

## 仓库结构

```text
.
├─ index.js
├─ lib/
│  └─ protocol.mjs
├─ tests/
├─ package.json
├─ dsh.bundle.patch.yml
├─ dsh.bundle.patch.example.yml
├─ install.ps1
├─ test-local.ps1
└─ docs/
   └─ DESIGN.md
```

## 开发原则

这个项目不是为了把 DeepSeek Harness 做成一个“远程 Shell”。

核心原则是：

> **GPT 负责决策，Cloud 负责调度，Harness 负责真实执行；任务通过明确的 Session、Workspace 和权限边界连接起来。**

因此 Cloud 不直接控制本机文件路径，也不持有本机模型凭据。Harness 仍然是本地执行权限的最终边界。

## License

当前仓库尚未添加开源许可证。若后续准备公开复用，建议明确补充 LICENSE。
