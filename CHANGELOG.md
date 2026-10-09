# Changelog

## 0.7.13 — P0 Reliability Preview

> **Prerelease — NOT a stable release.** This is the P0 Reliability Preview for the Chat Bridge wake path. The fixes below are covered by 370/370 simulated tests, but real end-to-end acceptance (real target conversation message, real ChatGPT result consumption and `ack_project_event`) has **not** been validated, so this release is **NO-GO for stable** and is published as a GitHub prerelease only. Installing it replaces the running Connector generation: **a Harness restart is required before the new build is loaded.** Do not treat it as an A/B-verified release.

- Align send and reconcile on one conversation identity: trailing slashes, harmless query parameters, a `www.` host and the `/g/<project>/c/<id>` spelling of the same conversation id all resolve to the same target, while a different conversation id, the home page, an auth page and non-HTTPS URLs fail closed. `reconcileDelivery` no longer reports `target_missing` for a tab that is open under a cosmetic URL variant.
- Keep `wake_target` above the global `chatBridgeChatUrl` in both paths, and keep reconciliation strictly read-only: it never navigates, never inserts, never clicks, never opens a tab to search, and stops with an explicit reason instead of risking the current draft.
- Fix the send-control `disabled` test: the previous `||`/`&&` precedence reported a disabled `data-testid="send-button"` as enabled, and the anchored label list missed the real `发送消息` label. A control now counts as the send control only when it is visible, enabled, near the composer, not a stop/voice/attach/dictate/share control, and its label really names the send action.
- Remove the blind Enter fallback. When no safe clickable control appears, the verified draft is retained and reported instead of being submitted through an unverified key event; a draft dropped by a hydration re-render is re-inserted at most three times before anything is submitted.
- Wait for page hydration and a stable toolbar (up to 15s, three identical reads) before clicking, never click while the conversation is still generating or a stale Stop control is on screen, and extend post-click confirmation to 6s. A confirmation timeout still holds the `MESSAGE_KEY` for read-only reconciliation and never submits twice.
- Enrich delivery diagnostics with draft retention, draft insertions, send-control presence and enabled state, submit attempt, conversation visibility and manual-intervention flags, and persist the reconcile-side fields without a database migration.
- Add regression coverage for label-only and disabled real DOM send buttons, slow hydration, dropped-draft re-insertion, in-progress generation, lookalike `Send feedback` controls, `target_missing` plus URL variants, wrong-chat fail-closed targeting, `wake_target` precedence, single bounded safe-draft recovery, non-retained drafts and confirmation-timeout holds.

Scope of this preview, in the order the wake path runs:

- **Bootstrap browser health only** — the startup health check no longer depends on, or disturbs, the bound conversation.
- **No tab stealing** — reconciliation and target lookup are strictly read-only and never navigate, insert, click or open a tab.
- **`wake_target` as an independent target** — a per-delivery wake target outranks the global `chatBridgeChatUrl` instead of being merged with it.
- **Draft protection** — no blind Enter fallback; a verified draft is retained rather than submitted through an unverified control, with a single bounded safe-draft recovery.
- **Outbox phase crash recovery** — persisted sanitized phase diagnostics plus in-place record extension let an interrupted delivery be reconciled after restart instead of blindly resent.
- **Dedupe, ACK identity and bounded retries** — one conversation identity across send and reconcile, a durable short lease, bounded exponential retry, and Cloud acknowledgement retried independently of the message.
- **370/370 simulated tests pass**; real end-to-end A/B acceptance and ChatGPT `ack_project_event` remain unverified.

## 0.7.12 — Trusted Self-Update Source Recovery

- Read the installed Git source from the active profile held by the official Harness Plugin Manager; `listBundles()` does not expose a source field.
- Accept supported GitHub dependency-spec spellings only for the exact `aevyrian/deepseek-worker` repository, while continuing to reject local, registry, fork, tarball, and unknown sources.
- Give older installs with missing or untrusted source metadata a one-time official Plugin Manager migration instruction; do not expose raw untrusted URLs in status or errors.
- Preserve exact tag-to-commit and package verification, Worker Drain, and the official Plugin Manager install path.
- Add regression coverage for legacy and current Git specs, fail-closed migration, the actual profile property, and consecutive upgrades after restart.

## 0.7.11 — Durable Chat Bridge Recovery

- Reconcile uncertain deliveries on a persisted exponential schedule, with a durable short lease to prevent concurrent checks and bounded manual-review reporting.
- Preserve message identity and wake target while extending existing Outbox records in place; legacy Outbox rows remain readable and recoverable after restart.
- Confirmed sent messages transition to delivered and Cloud acknowledgements retry independently without resending.
- Only an explicit, matching message key in a ready composer permits one bounded safe-draft retry; missing or unreadable message state remains uncertain.
- Store sanitized phase diagnostics for target lookup, frame validation, page confirmation, submission state, and Cloud acknowledgement.

## 0.7.10 — Update Discovery and One-click Reinstall

- 修复 HTTP 200 但版本过期的 Cloud 清单阻止检查 GitHub Release 的问题，并在状态中显示检查来源、版本、时间和错误原因。
- 将手动检查更新与安装分离；Connector 界面始终提供“检查更新”和“一键强制更新”。
- 强制更新只从受信任的 GitHub Release/Tag 解析精确 commit、核验 package metadata，再调用 Harness Plugin Manager；支持同版本重新安装，并继续经过 Worker Drain。
- 本版本不会自动恢复 Site 端 Admission Control 暂停状态。

## 0.7.9 — Connector Stability Release

- 正式发布 0.7.x 开发测试迭代中的 Chat Bridge 自动回传可靠性修复：持久化 Outbox、发送结果核验、有限指数退避及失败诊断保留。
- 增加安全 Worker Claim Drain 与运行时 Build Hash 报告。
- 支持消费 Site 显式提供的 delivery wake target；本版本不提供原始 ChatGPT 对话来源的自动识别。

## 0.7.9-beta.1 — Stability Test Release

- Adds durable Chat Bridge delivery recovery with bounded exponential retry backoff and retained failure diagnostics.
- Reconciles interrupted sends after restart before retrying, preventing blind duplicate submissions.
- Adds an atomic Worker claim drain for safe updates and reports the loaded Connector build fingerprint.
- Includes delivery-specific wake target persistence and validation where supplied by the Site; this release does not identify the originating ChatGPT conversation automatically.
- This is a beta test release and is not the stable 1.0.0 release.

## 0.7.8 — Chat Bridge Composer Wait

- Chat Bridge readiness checks now wait for the SPA-rendered composer within a bounded deadline. `testBridge` and `sendMessage` share the same wait path and report conversation changes or login transitions while waiting.

## 0.7.7 — Chat Bridge Page Script Fix

- 修复 `loginStateScript` 中的正则在模板字符串生成后成为非法 JavaScript、导致 `Runtime.evaluate` 返回 `page-script-exception` 的问题。
- 登录路径检测改为 pathname 前缀判断；fake Runtime.evaluate 测试新增真实 JavaScript 语法编译检查。

## 0.7.6 — Chat Bridge Runtime Diagnostics

- 改进 Chat Bridge `testBridge` 运行态诊断，不再将 `Runtime.evaluate` 失败误报为 conversation 无法访问。
- 为导航期间 transient CDP evaluation 错误增加有限重试，并增加基于 Target metadata 的实际 URL fallback。
- 区分 conversation、navigation、page evaluation、page script、login 和 composer 错误；Host Remote 透传具体 Bridge error code。

## 0.7.5 — Chat Bridge Conversation Targeting

- 修复多个 ChatGPT 页面同时打开时，`testBridge` 可能绑定到错误 target 的问题。
- 优先选择已绑定的 conversation target；绑定失败时提供安全的 expected/actual URL 诊断。

## 0.7.4 — Chat Bridge Host Remote 修复

- 注册 `openBridgeBrowser` 和 `testBridge` 为 Host Remote methods，修复 Harness UI 调用时返回 `gateway/internal`。

## 0.7.3 — Chat Bridge Reliability

- Bridge Test accepts the bound ChatGPT conversation across query/hash changes and SPA navigation while still requiring the exact conversation pathname and composer, without sending a message.
- Bridge settings distinguish operational states instead of treating a configured binding as ready.
- Bridge Open/Test save only Bridge settings, so unrelated invalid configuration does not block the action; Bridge-specific save failures remain visible.
- WakeCoordinator, WakeTransport, durable outbox, and orchestration behavior are unchanged.

## 0.7.2 — Chat Bridge Browser Interaction

- Opening the Chat Bridge sign-in browser now activates an existing ChatGPT tab or creates one, restores its window, and brings it forward.
- Bridge testing now checks the configured conversation, recognizes a required ChatGPT login, and confirms the composer without sending a message.
- Preserves the prior bridge availability signal used by Worker registration and heartbeat after successful wake delivery.

## 0.7.1 — Production v13 Chat Bridge Compatibility

- 在 Cloud terminal result/failure 成功响应未包含正式 `bridge_delivery` 时，启用 Chat Bridge 创建本地 durable wake outbox 记录，并以 project/task/terminal state 确定性生成 message key。
- 重启时恢复未完成的本地及 Cloud delivery；Cloud 正式 delivery 优先，并抑制同一终态任务的本地 wake，避免双重唤醒。
- `[DSW]` 仅发送 `PROJECT_EVENT_PENDING`、项目/任务 ID 与 message key；浏览器发送成功只确认本地投递，不调用 Cloud bridge ack 或确认 Project Event。
- Production Site v13 和 D1 schema 无需变更。

## 0.7.0 — Free Dual Channel

- 第一原则改为免费可用：正式总控只保留 `native / bridge / auto`，移除 0.6.0 的 OpenAI Responses API 付费 fallback。
- 新增本机 Chat Bridge：Connector 使用独立持久浏览器 Profile，把固定、极小的 `[DSW]` 事件控制消息发送回绑定的 ChatGPT 对话；真实结果仍由 ChatGPT 通过 DeepSeek Worker MCP 读取。
- Native MCP Events 仍为优先通道；无订阅、订阅异常或 native grace 超时后，`auto` 转到 Chat Bridge。
- Worker terminal result/failure、register、heartbeat 支持结构化 bridge delivery；Connector 用确定性 `message_key` 去重，并通过 `/api/worker/bridge/ack` 回报投递状态。
- Chat Bridge 不接收 Cloud 任意 prompt，不发送任务结果、日志、凭据、Cookie 或本地路径；Cloud 只下发 project/event/task/revision 等标识。
- 新增本地 Chat Bridge 设置 UI、浏览器登录/测试入口、free dual-channel D1 schema、diagnostics 与回归测试。
- Connector / updater / UI 版本推进到 0.7.0；现有 0.6.0 可通过正式更新通道升级。

## 0.6.0 — Dual-mode Cloud Orchestrator

- 新增双模式项目总控：`auto / native / cloud`。默认 `auto` 优先使用 ChatGPT MCP Events；没有有效订阅、回调不健康或 native grace 过期后仍有 pending event 时，由 Cloud Orchestrator 接管。
- 新增 OpenAI Responses API 根总控核心，使用 Site 内部 function tools 调用 `read_result / submit_task / continue_task / retry_task`，不转发用户 OAuth Token，也不轮询 DeepSeek 任务状态。
- Native 与 Cloud 共用同一个 project orchestration lease，避免同一批事件被两边重复调度。
- Cloud run ID 与每个调度动作 request_key 均可确定性重建；OpenAI 请求中途失败后保留 pending event，并可用同一幂等键恢复，避免重复创建任务。
- 新增 durable user-decision 状态、Cloud run 审计、native subscription health 和项目级模式配置 D1 schema。
- 新增双模式策略、Responses tool loop、native/cloud 竞争、失败恢复、用户决策等回归测试。
- Connector / 项目版本推进到 0.6.0，让现有 0.5.0 用户能通过正式更新通道看到并安装这一轮架构更新；本机 Worker Pool 行为保持兼容。

## 0.5.0

- Connector 从单任务领取升级为受控的多任务 Worker Pool，可同时运行最多 24 个独立 Native Harness Session。
- 默认外层并发设为 24，并在 Connector 高级设置中可调；Harness 自身的 Subagent 深度与并发限制仍由 Harness 管理。
- Worker 主循环不再在单个任务执行期间阻塞：任务领取后立即进入后台执行池，主循环继续心跳、补充空闲槽位并维持 Cloud 在线状态。
- 新增活动任务数 / 最大并发状态，以及并发调度、重复 lease、防越界配置的回归测试。
- 这是事件驱动总控架构的第一阶段；Cloud 端 MCP Events / Project State 将在同一 0.5.x 架构线继续完成后再进入 1.0.0。

## 0.4.8

- 版本页现在区分“当前运行版本”和“磁盘已安装版本”；当新包已经落盘但 Harness 仍运行旧模块时，明确提示需要重启，不再让用户误以为安装失败。
- Connector 状态会通过 Harness Plugin Manager 读取已安装包版本；若磁盘版本高于当前运行版本，则自动标记为 `restart-required` 并把已安装版本作为最新版本展示。
- 增加旧版“总控执行模式”迁移：启动时通过 Harness 官方 Plugin Manager 检查历史 `@local/dsh-orchestrator-worker-preset` / `dsh-orchestrator-worker-preset` bundle。
- 旧 bundle 可在线卸载时自动停用并移除；无 HMR 的环境先停用并提示重启一次，下次启动继续完成清理。
- 迁移失败、bundle 仍被占用或 Plugin Manager 不可用时，不阻断 Connector、配对、Workspace、Native Session 或运行期“总控执行模式”注册。
- 不直接改写用户 Profile 文件，不触碰 Token、设备配对、Workspace 授权或现有 Session。
- 保持新安装默认更新通道为“正式版（stable）”；已有用户主动选择的通道不被强制覆盖。
- 新增旧 bundle 迁移回归测试。

## 0.4.7

- 恢复 Harness 预设列表中的“总控执行模式”，同时保持 Connector 可正常停用和卸载。
- 不再把 `@deepseek-ai/dsh-agent-preset` 作为 bundle 的第二个常驻 Loader 行；Connector 启动时通过 Harness 官方 Agent Preset Registry 动态注册 `orchestrator-worker`，停用/卸载时由同一生命周期自动注销。
- 重新安装并启用 Connector 后，“总控执行模式”会自动恢复。
- ChatGPT 远程 Worker 任务继续使用已验证稳定的 Native Session + 每任务总控执行契约，不因预设注册失败而阻断核心指挥链。
- 预设继续移除 Schedule 硬依赖，保留文件、Shell、搜索、子 Agent、Web 等核心执行能力。
- 新增动态 preset 注册、重复注册和 disposer 生命周期回归测试。

## 0.3.3-preview.6

- 修复 Connector 组合包无法直接卸载的问题：不再把常驻 `@deepseek-ai/dsh-agent-preset` 作为 Connector bundle 的第二个运行组件。
- 新 Native Worker Session 改用 Harness 内置 `standard` preset；“ChatGPT 总控 / DeepSeek 本机执行”的执行契约改为由 Connector 注入每个任务 Prompt，因此核心指挥能力不再依赖常驻自定义 Preset。
- 关闭 Connector 后不再留下仍运行的 `preset-orchestrator-worker` 阻止卸载。
- 保留同 Session continue、Workspace 校验、Native Session、Result Upload 与连接恢复逻辑。
- 增加回归测试：bundle 中不得重新引入常驻 orchestrator preset，任务 Prompt 必须携带执行优先契约。

## 0.3.3-preview.5

- 更新通道在中文界面改为“正式版 / 测试版”，不再直接向普通用户显示 stable / preview。
- 默认通道仍为“正式版”；底层配置与更新协议继续使用稳定的 `stable` / `preview` 内部值，不影响兼容性。
- 同步当前版本号，用于 1.0.0 前的最终真机验收。

## 0.3.3-preview.4

- 修复“总控执行模式”把 `@deepseek-ai/dsh-tool-schedule` 当作硬依赖导致新 Native Session 在部分 Harness 安装中报 `never started` 的问题。
- Schedule 不属于 ChatGPT → Worker → Harness 核心执行链，现从该 Preset 的必需工具集合移除；文件、PowerShell/Bash、Git/项目、子 Agent、Web 等核心执行能力保持不变。
- 增加回归测试，防止未来再次把可选 Schedule 组件作为总控 Preset 的硬依赖。
- Connector 版本推进到 `0.3.3-preview.4`，用于正式 1.0.0 前的最后真机核心指挥验收。

## 0.3.3-preview.3

- Connector bundle now ships a selectable `orchestrator-worker` Agent Preset named “总控执行模式”.
- The preset mirrors the current Standard-mode tool composition while replacing only the persona with a concise execution-first contract optimized for DeepSeek V4.1 Flash.
- New Native Worker Sessions are created with `agentPreset: "orchestrator-worker"`, so ChatGPT-controlled tasks use the dedicated execution Agent automatically.
- Existing continued/reworked tasks keep reusing their original Harness Session.
- No model/provider is hard-coded; the Harness model selection remains authoritative.

## 0.3.3-preview.2

- A failed or lost local Worker credential can be replaced through the normal ChatGPT connection flow. The Cloud keeps the old credential active until the same signed-in owner confirms the replacement in the browser.
- Startup checks pairing status before registration. Invalid credentials pause the Worker and show a reconnect action instead of repeatedly trying heartbeats.
- Repeated connection clicks reuse paired or pending state and do not replace a working credential before Cloud accepts a new pairing.

## 0.3.3-preview.1

### Workspace discovery compatibility

#### Added

- Connector register/heartbeat now synchronizes the current effective authorized Harness Workspace set to Cloud.
- Workspace advertisements contain only stable Workspace ID and an optional safe display title/name.
- Heartbeat keeps the Cloud allowlist current after Workspace authorization changes or Workspace deletion.
- Worker presence reports paused while authorization is empty, stale, or restricted, while still allowing Cloud to learn the safe empty/reduced Workspace set.

#### Security

- Workspace advertisements never serialize Harness cwd, local path, workspace path, Credentials, Worker Token, or arbitrary Workspace objects.
- Path-looking display titles are omitted instead of risking local path disclosure.
- Existing local `workspaceForTask()` authorization and Registry existence checks remain mandatory before Harness execution.

#### Compatibility

- Pairing architecture, Credential storage, Native Session architecture, and updater architecture are unchanged.
- This preview is intended for the first real `0.3.2 -> 0.3.3-preview.1` self-update E2E after the matching Cloud workspace-discovery update is deployed.

#### Validation

- Added permanent Workspace advertisement tests for multiple/empty Workspaces, add/remove synchronization, and path/secret non-disclosure.
- Existing updater and Workspace security tests remain in the Windows / Node 22 workflow.

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
