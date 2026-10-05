# Changelog

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
