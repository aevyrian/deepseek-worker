# Changelog

## 0.1.0-beta.2

### Added

- DeepSeek Harness 插件页中的中文可视化配置页。
- 外部 Bundle 的预构建 Browser Client（`dsh.client` / `./client`）。
- Harness Config / volatile 配置 schema。
- Harness Credentials 的 `LOCAL_WORKER_TOKEN` 状态与保存流程。
- 32 bytes 安全随机 Worker Token 生成。
- Workspace 添加、修改、删除与本地绝对路径校验。
- Connector / Native Session / Credential / Cloud / Worker / Last heartbeat 状态。
- 用户主动“测试连接”，复用现有 `POST /api/worker/register`。
- Host → Browser Typert Remote 控制面。
- HTTP 401 / 403、配对、网络与 TLS 的中文状态映射。
- 跨 Windows / POSIX 的 Workspace 路径归一化测试。

### Changed

- Worker loop 每轮读取 volatile 配置，而不是只在启动时读取一次。
- 空 Workspace allowlist 从“退出 worker loop”改为“fail closed + paused + 继续等待配置”。
- Endpoint / Worker ID / Workspace / Token 改变后会重新 register。
- Session Controller 在状态读取和任务执行时动态检测。
- 协议错误改为结构化 `WorkerApiError`，不直接把 Cloud response body 暴露给日志/UI。
- 版本升级为 `0.1.0-beta.2`。

### Security

- 已保存 Token 只通过 Harness Credentials 解析。
- Browser 永远不会通过 `describe` 读回 Credential Secret。
- 状态接口没有 Token 字段。
- Connector config snapshot 明确忽略 token-shaped 输入。
- Authorization 与当前 Secret 在日志中继续脱敏。
- Cloud 仍不能下发任意本地绝对路径。
- 默认 Workspace allowlist 仍为空并 fail closed。

### Validation

仓库级验证：

- `node --test tests/*.test.mjs`：13/13 通过。
- `node --check index.js`：通过。
- `node --check client.js`：通过。

尚未声称完成：

- Windows DeepSeek Harness Desktop 真机 UI 验证。
- Cloud ↔ Harness 完整任务闭环真机联调。

## 0.1.0-beta.1

- 初始 Harness Bundle。
- Worker register / heartbeat / claim / lease / events / result / failure。
- Harness Credentials Token resolve。
- Native Session Controller 主路径。
- Headless CLI fallback。
- Workspace allowlist。
- `task_id ↔ session_id` 续作设计。
- Secret 日志脱敏。
