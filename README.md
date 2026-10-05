# DeepSeek Worker Connector

> 让 ChatGPT 的云端 DeepSeek Worker 与本机 DeepSeek Harness 直接协同工作的 Harness 原生连接插件。

本仓库是 **DeepSeek Worker 系统的本地端组件**。它不是云端 MCP Site，也不是独立常驻的 Node Worker。

当前版本：**0.1.0-beta.2**

## 架构

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
本仓库 / DeepSeek Harness 插件
   │
   ▼
DeepSeek Harness
Session / Agent / Tools / Files / Shell / Git
```

当前 Connector 对接既有 Worker API：

```text
POST /api/worker/register
POST /api/worker/heartbeat
POST /api/worker/claim
POST /api/worker/lease/renew
POST /api/worker/events
POST /api/worker/result
POST /api/worker/failure
```

本仓库 **不会修改 ChatGPT Site、D1 或 Site Secret**。云端的 `LOCAL_WORKER_TOKEN` 仍需用户单独配置。

## beta.2 新增

beta.2 把 Connector 从“能安装、靠配置文件使用”升级为可以在 DeepSeek Harness Desktop 插件页中直接配置的插件：

- 中文可视化配置页
- Endpoint / Worker ID 配置
- Harness Credentials 中的 Worker Token 配置
- 安全随机 Token 生成
- Workspace 添加、修改、删除
- Poll / Heartbeat / Lease 等高级设置
- Native Session Controller / Headless fallback 状态
- Cloud / Worker / Last heartbeat 状态
- 主动“测试连接”
- Harness Config / volatile 配置即时更新
- 预构建 `client.js`，Git URL 安装后不要求用户手工 build

## 安装

在 DeepSeek Harness 的插件管理器中添加：

```text
https://github.com/aevyrian/deepseek-worker.git
```

也可以使用 CLI：

```powershell
dsh plugin --profile <你的-profile> add https://github.com/aevyrian/deepseek-worker.git
```

安装后启用 `DeepSeek Worker Connector`。

## 可视化配置

打开：

```text
DeepSeek Harness
→ 插件
→ DeepSeek Worker Connector
→ deepseek-worker-connector
→ 配置
```

配置页分为四部分。

### 1. 云端连接

默认：

```text
Endpoint:
https://deepseek-worker.sxfdgan.chatgpt.site/api/worker

Worker ID:
deepseek-worker-windows
```

Endpoint 必须使用 HTTPS。

### 2. Worker Token

Credential ref 固定为：

```text
LOCAL_WORKER_TOKEN
```

Token **不进入 Connector 配置**，而是通过 Harness 官方 Credentials 系统保存。

页面只会读取：

```text
已配置 / 未配置
是否可写
```

不会从 Credentials 重新读取并显示已保存的 Secret。

可以：

- 手工输入一个 Token 并“保存到 Harness”
- 点击“生成随机 Token”生成 32 bytes 随机熵对应的 64 位 hex Token
- 在刚生成时复制
- 将同一个值手工配置到 DeepSeek Worker Site Secret：`LOCAL_WORKER_TOKEN`
- 保存到 Harness 后页面清除该明文值

> 已保存 Token 无法从配置页重新查看。遗失时应重新生成，并同时更新 Harness Credentials 与 Site Secret。

Token 不会写进：

- `package.json`
- `dsh.bundle.patch.yml`
- Git
- README
- Local Storage
- URL
- Connector 状态接口
- 日志

## Workspace

Cloud 只传：

```text
workspace_id = novel
```

本地 Connector 保存映射，例如：

```text
novel   → E:\项目\deep
douyin  → E:\项目\douyin-download-manager
```

配置页支持添加、修改和删除。

校验规则：

- Workspace ID 不能为空
- Workspace ID 不能重复
- 本地路径必须是 Windows 或 POSIX 绝对路径
- Cloud 不能下发新的本地绝对路径

默认：

```yaml
workspaceAllowlist: {}
```

空白 allowlist 时 Worker 会 **fail closed / paused**。beta.2 不再因为启动时 allowlist 为空而永久退出循环；添加 Workspace 后，volatile 配置会在后续轮询中生效。

## 连接状态

配置页显示：

```text
Connector        已加载
Harness execution Native Harness / Headless fallback
Credential       已配置 / 未配置
Cloud            在线 / 未认证 / 离线 / 未测试
Worker           online / paused / error
Last heartbeat   时间
```

如果当前 profile 没有 `sessionController`，页面会明确显示：

```text
Headless fallback
```

而不是把它伪装成 Native Harness。

## 测试连接

“测试连接”只在用户主动点击时执行。

顺序：

1. 校验 Connector 配置
2. 检查至少一个 Workspace
3. Host 从 Harness Credentials 解析 `LOCAL_WORKER_TOKEN`
4. 请求现有：
   ```text
   POST /api/worker/register
   ```
5. 返回脱敏的结构化结果

可能显示：

- 连接成功
- Worker Token 未配置
- 云端 Token 缺失或不匹配（HTTP 401）
- Worker 尚未配对 / 未授权（HTTP 403）
- Workspace 未配置
- 网络无法访问
- TLS 错误

如果 Worker 尚未在 Cloud 配对，应先通过 ChatGPT 的 DeepSeek Worker MCP 注册该 Worker ID。Connector 不会绕过配对机制。

## 即时配置

beta.2 的以下字段使用 Harness Config / volatile 配置：

- endpoint
- workerId
- workspaceAllowlist
- poll interval
- heartbeat interval
- lease renew interval
- lease wait timeout
- headless fallback
- headless command / args

后台 Worker 每次循环读取当前配置。Endpoint、Worker ID、Workspace 或 Token 变化后会重新 register。

已经领取并正在执行的单个任务使用其开始时的配置快照，不会在任务中途切换 Workspace 或 lease 参数。

## 执行模式

主路径：

```text
ctx.sessionController
```

如果当前 profile 没有原生 Session Controller，并且允许 fallback：

```text
dsh --profile headless --json
```

headless 只是兼容路径，不是主执行路径。

## Browser / Host 边界

Browser Client 只负责：

- 配置 UI
- Credential 的 `describe / set`
- 显示状态
- 用户主动测试连接

Host 继续负责：

- Token resolve
- register / heartbeat / claim
- lease renew
- Harness Session
- headless fallback
- result / failure

Browser 不会拿已保存的 Bearer Token 自己请求 Cloud。

配置页通过 Harness 官方插件页面 slot：

```text
plugins.row.config
```

外部 Git Bundle 的 Browser half 通过：

```text
dsh.client
./client
client.js
```

提供。

Host → Browser 的运行状态和测试动作通过 Harness Typert Remote seam 暴露；Remote 方法没有 Token 返回字段。

## 安全原则

- HTTPS only
- Workspace 默认空白名单并 fail closed
- 不接受 Cloud 下发任意本地路径
- Token 只通过 Harness Credentials 保存与解析
- Authorization / Secret 日志脱敏
- 状态接口不返回 Secret
- 已保存 Token 不进入 Browser state
- Token 不进入 Local Storage / URL / Git
- 本地 Harness 插件属于高权限 Host code，安装前应确认仓库来源

## 从 beta.1 升级 beta.2

Harness 当前 Git 插件更新仍建议按“卸载旧版本 → 重新从 Git URL 安装”的方式操作：

1. 记下你现有的 Workspace ID 与本地目录映射。
2. 在插件管理器中禁用并卸载旧 beta.1。
3. 再添加：
   ```text
   https://github.com/aevyrian/deepseek-worker.git
   ```
4. 启用 Connector。
5. 打开插件配置页。
6. 检查 Credential 是否显示“已配置”。
7. 重新确认 Workspace allowlist。
8. 点击“测试连接”。

`LOCAL_WORKER_TOKEN` 存在 Harness Credentials 中，不在插件源码配置里；不过升级后仍建议在配置页确认其状态，不要假定所有 profile/卸载路径都会保留用户配置。

## 测试

仓库测试：

```powershell
npm test
```

覆盖：

- HTTPS endpoint
- Workspace ID / path / duplicate
- fail closed
- token 生成格式与最小熵
- Credential 状态不泄露 Secret
- 配置序列化不包含 Token
- Secret / Authorization redaction
- HTTP 401 / 403 映射
- network / TLS 映射
- Native / Headless 状态
- Worker 协议请求

这些测试属于 **仓库级代码验证**。

它们不等于 Windows DeepSeek Harness Desktop 真机联调。仍需要真实 Desktop 验证：

- Git 安装是否正常拉取 beta.2 dependencies
- 配置入口是否正常出现
- `client.js` 是否被当前 Desktop 版本加载
- Credentials `describe/set` 是否在该 profile 可写
- Host Remote namespace 是否成功 mount
- Native Session Controller 的真实识别
- Cloud ↔ Harness 实际 register / heartbeat / claim / task 执行闭环

## 仓库结构

```text
.
├─ index.js
├─ client.js
├─ lib/
│  ├─ connector-config.mjs
│  └─ protocol.mjs
├─ tests/
│  ├─ config.test.mjs
│  └─ protocol.test.mjs
├─ package.json
├─ dsh.bundle.patch.yml
├─ install.ps1
├─ test-local.ps1
├─ CHANGELOG.md
└─ docs/
   └─ DESIGN.md
```

详细架构见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

当前仓库尚未添加开源许可证。若后续准备公开复用，建议明确补充 LICENSE。
