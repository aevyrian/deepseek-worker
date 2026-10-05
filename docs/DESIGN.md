# DeepSeek Worker Connector 0.3.2 设计

## 1. 本轮边界

0.3.2 在 0.3.1 pairing/UI 基线上增加 Connector 自更新。Cloud Site、D1、MCP、`/api/worker/*` 与现有 Cloud pairing protocol 不在修改范围。

保留 0.3.0 的 WorkspaceId 与 per-worker pairing 方向，本轮修正 Host Credentials 真实契约、Remote failure boundary 与普通用户 UI。

## 2. beginPairing 的 Host 边界

Harness 当前 Credentials provider：

    resolve(ref) -> Promise<{ value, source } | undefined>
    describe(ref) -> Promise<{ configured, source?, writable }>
    set(ref, value) -> Promise<void>
    unset(ref) -> Promise<void>

0.3.0 的代码已有部分兼容函数，但 Host pairing 三个 Remote 没有用真实 Gateway discovery + 官方 Credentials object shape 做完整调用测试，而且 `beginPairing` 的部分 dependency preflight 位于 pairing HTTP error handling 之外。

因此真实 provider / registry 抛出的异常可能逃出 Remote business method，由 API Gateway 统一表现为 `gateway/internal`。仅凭真机 UI 中的 `gateway/internal` 无法还原旧版本机器上具体是哪一个底层异常，所以 0.3.1 不伪造一个未经日志证明的单一异常文本，而是关闭所有已知逃逸路径并用真 Host 调用测试锁定契约。

## 3. Credentials adapter

Host 内部统一：

    describeWorkerCredential(credentials)
    resolveWorkerToken(credentials)
    saveWorkerToken(credentials, token)
    clearWorkerToken(credentials)

`resolveWorkerToken` 只接受官方 `{ value, source }`；旧 string mock 不再被测试接受。

## 4. beginPairing

顺序：

1. normalize Connector config。
2. 至少一个 `authorizedWorkspaceIds`。
3. 验证授权 Workspace 仍在 `workspaceRegistry`。
4. `credentials.describe(LOCAL_WORKER_TOKEN)` 检查 provider 可写。
5. Host 生成随机 Worker Token。
6. `credentials.set(LOCAL_WORKER_TOKEN, token)`。
7. Host 计算 SHA-256。
8. 调用既有 `POST /api/pair/start`，请求体只包含 hash 与非 Secret 元数据。
9. 校验 Cloud 返回的 HTTPS `approvalUrl`。
10. 返回 Browser：state / pairingCode / approvalUrl / expiresAt，不返回 Token。

## 5. pairingStatus / disconnectPairing

`pairingStatus` 每次重新 `resolve` 当前 Credential，不缓存 Secret。成功状态规范化为：

    unpaired | pending | paired | expired | revoked | error

`disconnectPairing` 先使用当前 Credential 调用现有 Cloud disconnect，再删除 Harness Credential。Cloud 已断开但本地 unset 失败时返回明确 cleanup failure，不伪装成功。

## 6. Browser 一键连接

默认 UI 不暴露 Token 概念。

未连接：

    安装并连接 ChatGPT

点击后：

    save config
      -> beginPairing
      -> open approvalUrl
      -> polling pairingStatus every ~3s

pending：

    打开连接页面
    检查状态

paired：

    在 ChatGPT 中打开
    断开连接

## 7. 打开 URL

Connector 不知道也不猜 OpenAI Plugin Directory listing URL。

优先使用 Cloud 返回的 HTTPS `approvalUrl`。没有 retained approvalUrl 时，只基于已配置 Cloud endpoint 生成同 origin 的 `/setup`，可附短期 pairing code。

Browser 使用 Harness 客户端已有的外链模式：

    window.open(url, "_blank", "noopener,noreferrer")

没有 custom protocol callback、localhost callback 或 Token query 参数。

## 8. 页面 reopen 与 polling

页面加载：

1. Browser 调用 `remote.credentials.describe`，只读取 metadata。
2. 未配置 → unpaired。
3. 已配置 → 立即调用 Host `pairingStatus()`。
4. pending → 启动约 3 秒 polling。
5. paired / expired / revoked / error → 停止高频 polling。

Secret 不进入 Browser。

## 9. 高级 / 诊断

默认折叠，保留：

- Endpoint
- Worker ID
- 手动 Token
- 随机 Token
- 保存 Token
- intervals
- Headless fallback
- 测试连接
- pairing code diagnostics

这保证旧 Cloud / 开发 / 恢复兼容，而不污染普通用户主流程。

## 10. Workspace 与 Native Session

没有重构：

- `ctx.workspaces`
- `ctx.workspaceRegistry`
- `authorizedWorkspaceIds`
- `trustedWorkspaceMode`
- `sessionController.create({ workspaceId })`
- continue/rework 的 Session membership + cwd 校验
- Cloud local-path field rejection

## 11. Pairing 基线自动验证

自更新开发前的 0.3.1 pairing/UI 基线在 Windows `windows-latest` / Node 22 为：

    44 tests
    44 pass
    0 fail

Host probe 不是 mock 一个已经存在的 Client namespace；它加载真实 `index.js` 与 `WorkerControlService`，按 Gateway discovery 结构找到 receiver 后实际调用：

- status
- generateToken
- beginPairing
- pairingStatus pending
- pairingStatus paired
- pairingStatus expired
- disconnectPairing
- beginPairing with API unavailable
- test

Credentials mock 使用官方 `{ value, source }` shape。

Browser tests 覆盖 3 秒 polling、reopen、setup URL、Token 不进 URL/持久存储、普通 UI 与高级兼容入口。


## 12. 0.3.2 Self Update

自更新与 Worker/Pairing 解耦。UpdateProvider 只产生经过验证的 version/channel/source/ref metadata，不产生或执行命令。

Host 使用当前 Profile 的 ctx.pluginManager。现有 bundle source 必须由 listBundles() 证明属于受信任 GitHub 仓库。更新 spec 由 Connector 从固定 source + 已验证 exact ref 构造，不直接执行远端任意字符串。

正式 tag 会先解析为 commit SHA；随后读取该 commit 的 package.json 核验 package identity/version/bundle metadata。只有这些检查通过，才允许调用 installBundle()。

Worker runtime 用 workerBusy 覆盖 claim 到 result/failure/lease cleanup 的完整区间。更新状态进入 waiting-idle 后 runWorker 不再开始新 claim；已有任务不被中止。

Plugin Manager 对已安装 package replacement 返回 restart-required，所以新的 package 文件落盘后，当前旧 generation 继续运行到 Harness 重启。没有使用动态 import 新 bundle、强制 kill 或私有 Electron relaunch。

UpdateProvider 预留固定 Cloud endpoint /api/connector/latest；本版本不实现 Cloud 端，只在 endpoint 不可用时 fallback GitHub。

## 13. Self Update 最终验证

正式 `.github/workflows/test.yml` 在 Windows `windows-latest` / Node 22 上执行：

    node --check index.js
    node --check client.js
    node --check lib/connector-config.mjs
    node --check lib/protocol.mjs
    node --check lib/native-session.mjs
    node --check lib/pairing.mjs
    node --check lib/update.mjs
    npm test

最终 suite：

    75 tests
    75 pass
    0 fail

临时 `v031-self-update-validation` workflow 不进入 main；Windows 自更新验证已并入项目长期 `test` workflow。
