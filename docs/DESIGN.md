# DeepSeek Worker Connector 0.3.0 设计

## 1. 产品目标

最终用户流程：安装 DeepSeek Worker 应用 → 安装 Harness Connector → 选择 Workspace → 点击连接 → 使用 ChatGPT 身份确认 → 开始使用。用户不需要 Site 管理权限，也不需要复制全局 Secret。

## 2. 身份分层

每个 Connector 安装实例生成独立 Worker Token；Token 只保存在 Harness Credentials，Cloud 只保存 token_hash。Worker 身份由 `worker_id + token_hash` 组成，用户身份由配对确认页面的 Sign in with ChatGPT 提供。

## 3. 配对状态

`unpaired → pending → paired → revoked/unpaired`。

`/api/pair/start` 不接收原始 Token，只接收 SHA-256 `token_hash`。短期配对码不是长期认证凭据。

## 4. 本机 Secret

Credential ref 仍为 `LOCAL_WORKER_TOKEN`，但它只代表这台 Harness Worker 的设备凭据，不再对应 Site 全局 Secret。

0.3.0 显式兼容官方 `ctx.credentials.resolve() -> { value, source } | undefined`。

## 5. Worker API

配对完成后，现有 `/api/worker/*` 继续使用 Bearer。Cloud 通过 worker_id 查 active device，再比较 SHA-256 Bearer 与 token_hash。

## 6. Workspace

继续使用官方 WorkspaceId。Trusted Workspace 不扩大项目边界，Cloud 仍不能传任意本地路径。

## 7. UI

默认显示“连接 DeepSeek Worker / 配对码 / 打开配对页面 / 已配对 / 断开配对”。手工 Token 只放高级兼容区。

## 8. 迁移

Cloud 0.3.0 尚未部署时，旧手工 Token + 0.2.1 Cloud 仍可工作。配对 API 404 时 UI 明确提示 Cloud 尚未部署 0.3.0 配对 API。

详细 Cloud 契约见 `docs/CLOUD-PAIRING.md`。
