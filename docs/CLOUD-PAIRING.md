# Cloud Pairing Contract — 0.3.0

目标：任何用户安装应用与 Harness Connector 后都能自行配对，不需要 Site owner 为每个人修改 Secret。

## 身份来源

公开 ChatGPT Site 使用 Sign in with ChatGPT。用户登录后，Site 服务器可读取平台提供的：
- `oai-authenticated-user-email`
- `oai-authenticated-user-full-name`（可选）

授权判断必须在服务器端完成。官方 Sites 文档：https://learn.chatgpt.com/docs/sites

## D1

建议新增 `worker_devices`：

```sql
CREATE TABLE worker_devices (
  worker_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','active','revoked')),
  owner_key TEXT,
  owner_display TEXT,
  pair_code_hash TEXT,
  pair_expires_at TEXT,
  hostname TEXT,
  workspace_allowlist_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  paired_at TEXT,
  revoked_at TEXT,
  last_seen_at TEXT
);
CREATE INDEX idx_worker_devices_pair_code ON worker_devices(pair_code_hash);
CREATE INDEX idx_worker_devices_owner ON worker_devices(owner_key);
```

只保存 SHA-256 token_hash / pair_code_hash，不保存原始 Token 或原始配对码。

## POST /api/pair/start

无需 Bearer。请求包含：
`worker_id, token_hash, hostname, workspace_allowlist, client_version`。

服务端生成短期配对码（建议 10 分钟）并返回：
`state=pending, code, approval_url, expires_at`。

必须做 per-IP / per-worker rate limit。

## /pair?code=...

未登录时跳转/展示 `/signin-with-chatgpt`。登录后从平台请求头读取身份。用户确认后，将 pending device 标为 active，写 owner_key/paired_at，并清除配对码。

## POST /api/pair/status

使用本机 `Authorization: Bearer <worker-token>`。Cloud 对 Bearer 做 SHA-256 后匹配该 worker 的 token_hash。pending 也允许查询自己的状态。返回 pending/paired/revoked/expired，不返回 owner email。

## POST /api/pair/disconnect

要求 active Worker Bearer。将设备标为 revoked，之后所有 `/api/worker/*` 拒绝该凭据。

## /api/worker/* 鉴权迁移

删除“Bearer 必须等于全局 Site Secret LOCAL_WORKER_TOKEN”的比较。

新逻辑：
1. 从 body 读取 worker_id。
2. D1 查 worker_devices。
3. 必须 state=active。
4. SHA-256 Bearer。
5. 常量时间比较 token_hash。
6. 再执行 workspace_allowlist 与租约校验。

这样每台机器独立，一台凭据泄露不会影响其他用户。

## 迁移顺序

先让 Cloud 同时接受旧全局 Secret和新 active per-worker token，验证一键配对；再停止创建旧全局 Token；最后移除 Site `LOCAL_WORKER_TOKEN` Secret。
