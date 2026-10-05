# DeepSeek Worker Connector

DeepSeek Harness 原生本地 Worker Connector。目标是让用户安装 ChatGPT 中的 DeepSeek Worker 应用，再安装本 Connector，即可把自己的 Harness Workspace 交给 Cloud 调度，不需要进入 Site 后台复制全局 Secret。

当前版本：**0.3.0**

## 0.3.0：一键设备配对

0.2.1 的 `LOCAL_WORKER_TOKEN = Site Secret` 是单人部署方案。0.3.0 改为每台 Harness Worker 自己拥有独立凭据：本机随机生成 Token，只保存到 Harness Credentials；Cloud 只保存 SHA-256 token hash。

普通用户流程：

1. 在 Harness 创建 Workspace。
2. 安装本 Connector。
3. 勾选允许使用的 Workspace。
4. 点击 **连接 DeepSeek Worker**。
5. Connector 自动创建短期配对。
6. 打开配对页面，用 ChatGPT 身份确认。
7. 自动变为“已配对”。
8. 之后直接从 ChatGPT 下发任务。

普通用户不需要知道 Token，也不需要修改 Site Secret。

## 兼容

0.3.0 仍保留“高级：手动 Token”作为旧 Cloud / 诊断兼容入口。Cloud 配对 API 尚未部署时，旧 0.2.1 单人链路仍可使用。

正式 0.3.0 Cloud 部署后，应停止使用全局 `LOCAL_WORKER_TOKEN` Site Secret，改为按 `worker_id` 校验 D1 中的 `token_hash`。

## Workspace 与权限

- Browser 读取官方 `ctx.workspaces`。
- Host 使用 `ctx.workspaceRegistry`。
- Cloud 只传真实 Harness `workspace_id`。
- 拒绝 Cloud task 中的 `cwd/path/workspace_path/local_path`。
- Trusted Workspace 内不增加第二套 read-only / Shell allowlist；实际权限继续由 Harness 与 OS 决定。

## 配对 API

Connector 0.3.0 预期 Cloud 提供：

- `POST /api/pair/start`
- `POST /api/pair/status`
- `POST /api/pair/disconnect`
- `/pair?code=...` 配对确认页面

完整协议与 D1 设计见 [docs/CLOUD-PAIRING.md](docs/CLOUD-PAIRING.md)。

## 安装

`https://github.com/aevyrian/deepseek-worker.git`

## 当前部署状态

Connector 0.3.0 已实现配对客户端协议与 UI；Cloud 端需要按 `docs/CLOUD-PAIRING.md` 升级后，一键配对才能真正完成。
