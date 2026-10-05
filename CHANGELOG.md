# Changelog

## 0.3.2

### Self Update

#### Added

- 正式发布 Harness Connector 自更新：默认检查 stable 更新，并在 Worker 完全空闲后安装。
- 通过 Harness 官方 Plugin Manager 替换 Connector package，成功后要求重启 Harness。
- 只接受受信任 GitHub 仓库中的版本 tag，并在安装前解析为不可变 commit SHA、验证 package 元数据。

#### Preserved

- Credentials、Workspace 授权、设备配对身份、Native Session 与 continue/rework 状态。
- Cloud、D1、MCP 与现有 pairing protocol。

#### Validation

- Windows GitHub Actions / Node 22 workflow 通过；更新器、Host Remote、配对、Workspace 与 Session 覆盖纳入永久测试流程。
- JavaScript syntax checks 与 `npm test` 在 PR CI 中通过。

## 0.3.1

### Self Update

#### Added

- 启动后自动检查正式更新；默认 autoUpdate=true、updateChannel=stable。
- 独立 UpdateProvider：Cloud manifest 优先，固定 GitHub Releases/Tags fallback。
- 正确 SemVer 比较、stable/preview 通道、同版本/降级/非法版本拒绝。
- trusted source allowlist，只允许 aevyrian/deepseek-worker。
- 正式 Git tag 先解析成 exact commit SHA，并预验 package name/version/bundle metadata。
- Worker busy fence：Task 进行中进入 waiting-idle，Task 完成后才安装。
- 非敏感更新状态：currentVersion/latestVersion/updateState/lastCheckedAt/restartRequired/lastUpdateError。
- 普通 UI 增加版本、自动更新、channel、状态和失败重试。

#### Harness integration

- 自更新只调用官方 ctx.pluginManager.listBundles() 与 ctx.pluginManager.installBundle(spec, { enabled: false })。
- 已安装 package replacement 成功必须得到 Harness restart-required，不热加载新 Host JS。
- Plugin Manager 的 package transaction/validation failure 使用 Harness 自己的 profile manifest/lock rollback。
- 当前未发现面向第三方插件的通用 Desktop restart/relaunch API，因此只提示用户重启。

#### Preserved

- Credentials / LOCAL_WORKER_TOKEN。
- authorizedWorkspaceIds / trustedWorkspaceMode / endpoint / workerId。
- pairing identity 与 Cloud pairing protocol。
- Native Session / continue / rework。
- Cloud Site / D1 / MCP / /api/worker/* 均未修改。

#### Validation

- 正式 Windows GitHub Actions / Node 22 workflow 通过。
- JavaScript / MJS syntax checks 全通过，包含 `lib/update.mjs`。
- `npm test`：**75/75 pass，0 fail**。
- 覆盖 SemVer、stable/preview、可信 source、tag→commit、package metadata、busy fence、Plugin Manager failure/compatibility 与 Remote/UI 状态。

### Pairing / UI fixes

#### Fixed

- 修复 Windows DeepSeek Harness Desktop 中 `beginPairing()` 可能被 Gateway 折叠为 `gateway/internal` 的 Host 路径。
- pairing Host methods 全部按 Harness 当前 Credentials API 处理 `resolve(ref) -> { value, source } | undefined`。
- `beginPairing` 的 Workspace Registry 与 Credential preflight 不再让本地异常直接逃出 Remote method。
- `pairingStatus` 与 `disconnectPairing` 使用同一严格 Credential 解包逻辑。
- 修复本轮测试中发现的 Credential helper 递归缺陷。

#### Changed

- 普通 UI 改为“设备连接”优先，不再首先展示 Token / Endpoint / Worker ID。
- 默认按钮为“安装并连接 ChatGPT”。
- pending 状态显示“打开连接页面 / 检查状态”。
- paired 状态显示“在 ChatGPT 中打开 / 断开连接”。
- Endpoint、Worker ID、手动 Token、interval、Headless fallback 与测试连接全部移入默认折叠的“高级 / 诊断”。
- 页面 reopen 时，如果 Credential 已配置，会自动调用 `pairingStatus()` 恢复状态。
- pending 每约 3 秒 polling，paired/expired/revoked/error 自动停止。

#### Security

- 自动配对 Token 由 Host 生成并先写入 Harness Credentials。
- `pair/start` 只发送 SHA-256 `token_hash`，不发送原始 Token，也不带该 Token 的 Bearer。
- Browser 不读取保存后的 Token。
- Token 不进入 Config、Local Storage、Session Storage、URL、Query String、Clipboard 或日志。
- approval URL 只接受无 username/password 的 HTTPS URL。
- Connector 不猜 ChatGPT Plugin Directory URL；优先消费 Cloud 返回的 `approvalUrl`，兼容使用 Cloud `/setup` 入口。

#### Preserved

- Cloud Site / D1 / MCP / `/api/worker/*` / Cloud pairing protocol 未修改。
- Harness WorkspaceId、`authorizedWorkspaceIds`、`trustedWorkspaceMode`、Native Session、continue/rework、Cloud path 拒绝全部保留。

#### Validation

Windows GitHub Actions / Node 22：

- JavaScript / MJS syntax checks 全通过。
- `npm test`：**44/44 pass，0 fail**。
- Host discovery probe 经 Gateway-style discovery 实际调用 pairing 三个 Remote。
- 覆盖 official Credential object shape、pending→paired、expired、API unavailable、Browser polling/reopen 与 Token URL/持久化约束。

## 0.3.0

### Added

- 一键设备配对：每台 Worker 自动生成独立 Token，Cloud 只接收 SHA-256 token hash。
- Host Remote 新增 `beginPairing / pairingStatus / disconnectPairing`。
- 默认 UI 改为“连接 → 配对页面 → ChatGPT 身份确认 → 自动上线”。
- 新增 `lib/pairing.mjs` 与 `docs/CLOUD-PAIRING.md`。

### Changed

- `LOCAL_WORKER_TOKEN` 改为本机设备凭据语义，不再要求普通用户配置全局 Site Secret。
- 手工 Token 移入高级兼容区。
- 401/403 提示改为设备凭据/配对语义。
- 显式兼容 Harness 官方 `resolve() -> { value, source }`。

### Compatibility

- Cloud 0.3.0 尚未部署时，旧手工 Token / 0.2.1 Cloud 仍可通过高级兼容入口使用。
- 配对 API 404 会明确提示 Cloud 尚未部署 0.3.0 配对 API。


## 0.2.1

### Fixed

- Host Remote owner 不再创建在 `ctx.inject(["credentials", "workspaceRegistry"], childScope)` 中。
- Connector Host 插件现在直接导出正式 `TypertRemoteService`：
  - service key: `deepseekWorkerConnectorControl`
  - namespace: `deepseekWorkerConnector`
- Worker loop 改为 Host Service 生命周期 effect，不再决定 Gateway 能否发现 Remote Service。
- `status / generateToken / test` 现在按 Harness API Gateway 当前 source-mode discovery 所需的 Host Service registry 结构注册。
- Credential provider 改为通过 `ctx.get("credentials")` 可选解析，provider 缺失时 Remote namespace 仍可存在并返回明确状态。
- “生成随机 Token”与 Credentials 异常不再统一显示“配置保存失败”。

### UI / diagnostics

- 新增 Host Remote 不可用、Gateway service unavailable、Credential Remote 不可用、Credential provider 不可写/不可用、Token 保存失败等区分提示。
- UI 不直接显示 Remote 原始错误文本作为 Token 保存错误。
- Credential provider 拒绝写入时只显示错误类别，不回显 Token。

### Preserved

- Harness WorkspaceId / authorizedWorkspaceIds。
- trustedWorkspaceMode。
- Native Session create / continuation。
- `ctx.credentials` 与官方 `ctx.remote.credentials.describe/set`。
- Cloud API、D1、MCP、Secrets 与所有 `/api/worker/*` 均未修改。

### Validation

Windows GitHub Actions / Node 22：

- 所有 JavaScript / MJS syntax check 通过。
- `npm test`：28/28 通过。
- 新 Host discovery 测试加载真实 `index.js` / `WorkerControlService`，按 Harness Gateway 当前 discovery 结构验证 `reflect.props → ctx.get(serviceKey) → typertRemote → remoteMethods`，并经该发现路径调用 `status / generateToken / test`。
- 新 Credentials 测试验证 describe/set 错误分类和 Token 不泄露。

## 0.1.0-beta.3

### Fixed

- 修复 Windows DeepSeek Harness Desktop 中 remote.deepseekWorkerConnector 未正确 inject 的错误。
- Remote lifecycle 改为先 mount contribution，再创建明确 inject remote.deepseekWorkerConnector 的 UI fiber，dispose 顺序为 UI → Remote。
- 修复 status Remote 失败时错误显示 Headless fallback；现在区分“检测中 / 未知 / Native / Headless”。

### Changed

- Connector 项目边界改为 DeepSeek Harness 官方 Workspace。
- 删除手工 Workspace ID + 本地路径输入 UI。
- 删除功能性的本地路径 allowlist map。
- 配置改为 authorizedWorkspaceIds。
- Cloud workspace_allowlist 中的值改为真实 Harness WorkspaceId。
- Browser Workspace 列表直接来自官方 ctx.workspaces service。
- Host 通过 ctx.workspaceRegistry 验证 Workspace 是否仍存在。
- Native 新 Session 使用 sessionController.create({ workspaceId })，不再由 Connector 自己传 cwd。
- continue / rework 在恢复前校验 Session membership 与官方 Workspace canonical path。
- Native 执行改用当前 Session Controller 的 create / resolveAgent / prompt 能力。
- Headless fallback 只使用 Workspace Registry 提供的官方 canonical path。

### Added

- trustedWorkspaceMode，默认 true。
- Trusted Workspace 内 Connector 不增加第二层文件/Shell/Git 命令限制，实际权限继续由 Harness 与 OS 决定。
- 受限模式当前暂停远程 claim，避免假装提供未实现的半权限沙箱。
- Workspace 删除后的 fail-closed 状态与 UI 清理提示。
- Cloud task 本地路径字段拒绝：cwd、path、workspace_path、local_path。
- lib/native-session.mjs，用于隔离并测试 Workspace-native Session 行为。
- Remote Client lifecycle、WorkspaceId、Native Session continuation 等 beta.3 测试。

### Security

- LOCAL_WORKER_TOKEN 继续只通过 Harness Credentials resolve / set。
- Browser 不读取已保存 Secret。
- Token 不进入 Connector Config。
- Cloud 即使在 Trusted Workspace 模式也不能指定任意本机路径。
- 只有用户明确授权且仍存在的 Harness WorkspaceId 才能接收任务。
- Connector 不修改或绕过 Harness permission preset、工具审批、sandbox 或 OS 权限。

### Validation

GitHub Actions / Node 22：

- node --check index.js：通过
- node --check client.js：通过
- node --check lib/connector-config.mjs：通过
- node --check lib/protocol.mjs：通过
- node --check lib/native-session.mjs：通过
- npm test：24/24 通过，0 fail

仍需 Windows DeepSeek Harness Desktop 真机验证实际 UI、Remote namespace、Credentials、Workspace 列表、Cloud register/heartbeat/claim 与真实 Session 执行闭环。

## 0.1.0-beta.2

- 增加 Harness 插件页中文可视化配置。
- 增加 Credentials Token 配置、随机 Token、状态与测试连接。
- 增加 Browser Client 与 Connector Remote 控制面。
- 当时 Workspace 仍使用 Connector 自维护的本地路径映射；beta.3 已废弃该设计。

## 0.1.0-beta.1

- 初始 Harness Bundle。
- Worker register / heartbeat / claim / lease / events / result / failure。
- Harness Credentials Token resolve。
- Native Session Controller 主路径设计。
- Headless CLI fallback。
- task_id ↔ session_id 续作设计。
- Secret 日志脱敏。
