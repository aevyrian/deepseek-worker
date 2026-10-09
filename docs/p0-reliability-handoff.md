# DeepSeek Worker P0 修复与上下文续接记录

更新时间：2026-10-09，Asia/Shanghai。本文先保存当前检查点；最终提交、测试数字和未解决问题将在本轮结束前更新。

## 用户目标与边界

ChatGPT 发起任务后结束当前回合，Worker 独立执行，通知返回明确绑定的原始聊天，ChatGPT 读取真实结果、继续编排并调用 `ack_project_event`。禁止拿输入框草稿、按钮点击、浏览器在线或模拟测试代替完整闭环证据。

- 基线 `9a24513672c3253cc0381cfec5da6c058b72b6ee`；保护所有已有工作树、分支和未提交修改。
- 不修改 main，不创建正式 tag/Release，不部署 Site，不运行生产 D1 migration。
- 不用既有卡住的 Project 自动重发，不清理生产 Outbox，不确认既有未处理事件。
- 2026-10-09 用户明确要求停止界面查看技能；后续不再调用该技能，不操作 Harness 窗口。
- 用户确认真实测试聊天为 `https://chatgpt.com/c/6ac7b73b-8dfc-83e8-aea7-f600de4ed59d`。另一条聊天上下文已满，只允许在新建独立测试 Project 中使用此目标。当前没有第二个可供真实 A/B 验收的目标。
- 官方 Desktop Host Plugin Manager 安装前须精确提交核对、备份和回滚准备；不强杀 Harness。重启必须由用户在安装任务结束后执行。

## 工作树与文件所有权

| 工作包 | 工作树 | 文件所有权 |
|---|---|---|
| 统一集成、Bootstrap、发送与模拟 CDP | `E:\项目\dw-p0-integration-20261009-codex`，分支 `integrate/p0-reliability-20261009-codex` | Agent integration 负责 `lib/bridge-bootstrap.mjs`、`lib/chat-bridge.mjs` 及其测试和 multichat 测试 |
| 持久协议与恢复 | `E:\项目\dw-p0-protocol-20261009-codex`，分支 `fix/p0-protocol-20261009-codex` | Agent protocol 负责 `lib/bridge-outbox.mjs`、`lib/wake-transport.mjs`、必要的 `lib/wake-coordinator.mjs` 及对应测试 |
| 官方能力报告与独立审查 | `E:\项目\dw-p0-platform-20261009-codex`，分支 `docs/p0-platform-20261009-codex` | Agent platform 负责 `docs/p0-platform-boundaries.md`；对其他 Agent 改动只读审查 |
| 主控 | 统一集成工作树 | `lib/build-identity.mjs`、`tests/build-identity.test.mjs`、本文、验收/打包证据 |

不要在 Agent 工作尚未完成时直接修改其所属文件。中断后先查看工作树状态与子 Agent 状态，保留未提交改动。

## 已提交的集成检查点

A/B/C 按用户指定顺序 cherry-pick，均无文本冲突：

| 原始提交 | 集成提交 |
|---|---|
| A `a8bd64b83e424084763138b1f2b333f4f9d28086` | `3f7220f` |
| B `6500356ea605219ceeed801bfe1fae16e8b63a4b` | `d247820` |
| C `e5583de0adcf9194e529cf3676d6437f1928275e` | `47b0a15` |

主控新增：`ece96c9`，指纹覆盖 package/index/client 和全部 lib 执行源码；针对 Bootstrap、coordinator、native session 和 client 修改的验证通过 2/2。指纹在模块加载时冻结，不能随运行期间磁盘修改悄悄改变。

平台报告原提交 `05b3964d802ec2d2c99f32e0e5553ef538531637`，集成为 `26b4634`。完整官方来源、匿名身份与 URL 区分、绑定恢复和 ACK 语义见 `docs/p0-platform-boundaries.md`。

此检查点的 integration/protocol 后续修复仍在工作目录中，未提交完成前不能作为可安装版本。

## 已证实的缺陷与修复方向

1. Bootstrap 使用浏览器健康信号直接覆盖投递状态，可能抹去 `uncertain`/`needs-login` 和真实错误；应分开浏览器能力与每条消息投递状态。
2. 旧 Bootstrap 的信号式超时依赖被调用方遵守取消；未使用硬 deadline race 时可能无限等待。离线时 `allowLaunch` 每轮为 true，与每 outage 一次启动的注释不一致。
3. 同一聊天并发发送缺少完整互斥；预检后用户新增草稿、插入后草稿变化及点击前发送状态需重新验证。
4. 原 Outbox 仅实例级锁；同进程另一实例初始化可将正在发送的记录当崩溃。历史记录按数量裁剪会丢去重凭证，亦可能删除未完成 transport ACK 的记录。
5. 本地未决通知被 Cloud 接管时，旧实现可能新建 pending 消息，改变页面去重身份；必须保留原 message key 并分开正式 Cloud ACK key。
6. 独立审查发现 same-key 本地记录的 Cloud adoption 分支未切换 Cloud 元数据，导致不进入 ACK 队列；Agent protocol 正在修复。
7. 仅 uncertain reconcile 有界不足以满足要求；pending delivery 与 ACK-only 重试也需要次数/时间边界，触界保留记录并明确人工处理。
8. 原指纹未覆盖 Bootstrap、coordinator 和 native execution 等关键源码。已经扩展源码覆盖，但旧指纹与新指纹算法不同，不能直接比较来断言回滚。

## 需验证或明确披露的风险

- 文件锁与发送/ACK owner 的 PID 重用或同进程插件重载可能使旧 owner 被误认为仍活跃。不能以超时直接重发未决通知；应 fail closed，并明确锁恢复/人工处理语义。
- `safe_draft + target_missing` 恢复需要保留此前安全证据，重新打开目标后必须先可靠检查真实用户气泡。读取历史失败不能当作“未发送”，不能从缺少目标标签推出安全重发。
- 进程可能在点击后、落盘前退出；UI 与 Outbox 不共享事务，因此无法承诺端到端 exactly-once。
- CDP 只检查当前加载的目标消息区域，历史消息加载及不同客户端是否恢复编排仍需真机验收。
- 草稿和提交阶段需通过 `onProgress` 在点击前持久化；旧记录没有阶段证据时必须保留 unknown，不伪造历史。
- 生产 Site 的来源元数据捕获与 immutable binding 实现不在当前 Connector 仓库中，尚未完成实现级审计。

## 只读线上/本地证据

针对既有事故 Project `project_82b089c1-a02c-4f6c-bdd2-6dab3717616d`、Task `task_4f6f11ee07cbbc3388dce7f4414863d506bd` 的本轮只读结果：

- Worker 状态 online；这不证明 Bridge 可投递。
- Project pending event count=1，mode=bridge，bridge_ready=false。
- Site latest delivery queued，attempts=0。
- Native active subscriptions=0，`events/subscribe=null`；discover/list 曾成功，不等于订阅成功。
- 本地对应 Outbox：uncertain / safe_draft，attempts=1，reconcile_attempts=9；诊断 target_found=false、frame_confirmed=false、message_visible=false。
- Windows 当时没有监听 CDP 9223；不能用这个时点证据推断事故全过程。
- 当前安装目录使用旧算法计算的磁盘指纹为 `65bb218c27c04fc576711cd8cdba716cade94cb274a6db1550e3adf636899e59`，与用户给出的后来指纹一致。仅磁盘源码证据，未取得当前加载实例的 Host status 指纹；不能据此确认是谁/何时更新、重载或回滚。
- 进一步核对：Desktop profile 的 Connector 安装 spec 指向官方仓库提交 `5b9f7639de8944cc5940ea24cda795535be113f2`，installed package version=0.7.12。比较 package/index/client 和安装目录全部 lib `.mjs`，共19个源码文件，统一 CRLF/LF 后全部与该旧提交一致；相对 `9a24513`，index、Outbox、chat-bridge 三个文件不同。**已证实当前磁盘安装仍为旧正式构建，不包含9a24513的三个修复文件。** 这可以解释当前磁盘指纹为何是旧值，但不证明是谁在何时更换了构建，也不证明当前进程具体加载哪个版本。

未证实新通知被发到旧聊天，不继承这样的根因判断。没有写入生产 Outbox，没有重发或 ACK 既有事件。

## 安装与真机验收阻塞

当前没有已验证可调用的官方 Desktop Host Plugin Manager 安装入口。只读窗口读取尝试曾返回 `FrameArrived timed out` 和 `window capture timed out`，随后用户要求停止该查看技能，已停止。不得用裸覆盖 node_modules、通用 CLI、强杀进程或未经验证的入口代替指定安装流程。

因此尚未安装候选构建，尚未重启，尚未发送任何新测试通知，尚未创建新验收 Project/Task，尚未通过真实气泡/ChatGPT 读取结果/业务 ACK 验收。

## 继续执行顺序

1. 完成各自未提交修复与有意义的定向测试；独立审查发现项必须确认已修或列为阻塞。
2. integration/protocol Agent 本地提交，协议提交 cherry-pick 到统一集成分支。
3. 主控审查最终接口、持久阶段、安全恢复、互斥及 ACK key；在合并后运行全量测试。
4. 保存测试输出，制作固定提交的本地候选包、源码指纹和安装核对清单。包必须来自提交快照，不能打包 Agent 仍在编辑的工作目录。
5. 取得官方安装入口后，先备份 Connector、profile 配置/lock 和 Outbox；安装精确候选提交。记录结果并让用户在任务结束后重启。
6. 核对 loaded commit/build fingerprint 与候选包一致，再在新 Project 中绑定用户确认的专用聊天，发唯一任务/MESSAGE_KEY。任务提交后结束编排回合，不让 ChatGPT 持续轮询。
7. 保存真实气泡、transport ACK、实际读取结果、后续决定和 `ack_project_event` 的证据。缺少第二聊天则真实 A/B 门槛仍未通过。

## 回滚原则

安装前备份必须成功并记录文件哈希。备份不得输出配置秘密、cookie、token 或聊天正文。候选失败时停止新领取，保留当前 Outbox 与未处理事件；先 reconcile，不盲目恢复陈旧 Outbox 快照覆盖后来状态。通过官方 Manager 恢复精确旧构建，让用户重启后核对 loaded fingerprint。必要的 Outbox 格式迁移必须保留 message key、target 和 ACK 证据。

## 发布结论

**当前 NO-GO。** 本地代码/模拟验证尚未完成统一验收，正式安装和真实消费闭环都没有通过。即使模拟测试最终全绿，也不能改变此结论，直到真实验收证据补齐。
