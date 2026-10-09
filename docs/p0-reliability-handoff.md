# DeepSeek Worker P0 修复与上下文续接记录

更新时间：2026-10-09，Asia/Shanghai。本地修复已统一集成；本文保存源码状态、证据、真实验收阻塞与下一上下文的操作边界。最终候选 SHA 与包指纹以交付目录的 `candidate-receipt.json` 为准。

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

后续修复均已提交并集成：

| 内容 | 原始/集成提交 |
|---|---|
| 健康状态分离、硬 deadline、单启动周期、共享发送队列、持久阶段与草稿保护 | `9ee252ba3f2c50f1b655e632541affca4ec7189b` |
| 最终发送按钮重新取位、完整 marker 匹配、助手引用排除 | `531d005601222ab6da1ad64b2b6475720bfe9a56` |
| 持久协议、跨进程互斥、崩溃恢复、正式 ACK alias、有界重试 | 原始 `72a791ccd2c43cc06127ecdbf8b7f029db85e511`，集成 `bf7afa27b5695b0d5482c7696277c6498b5e36d7` |
| 禁止 supersede 已尝试/需人工处理的本地通知 | 原始 `51b71f559f3a1d50ed5e5b7f41facdcb87d64bef`，集成 `e89bd70e0582e9835e09d0d4157ea50562b4056a` |

A/B/C 和后续协议提交都无文本合并冲突；C 的测试契约需要调整：缺目标标签现在新建独立标签、health 和 delivery 状态分离、取消全局绑定门槛、硬 deadline 使用组合取消信号。没有删除失败验收条件，新增了对应最终行为与安全反例。

## 已证实的缺陷与修复方向

1. Bootstrap 使用浏览器健康信号直接覆盖投递状态，可能抹去 `uncertain`/`needs-login` 和真实错误；应分开浏览器能力与每条消息投递状态。
2. 旧 Bootstrap 的信号式超时依赖被调用方遵守取消；未使用硬 deadline race 时可能无限等待。离线时 `allowLaunch` 每轮为 true，与每 outage 一次启动的注释不一致。
3. 同一聊天并发发送缺少完整互斥；预检后用户新增草稿、插入后草稿变化及点击前发送状态需重新验证。
4. 原 Outbox 仅实例级锁；同进程另一实例初始化可将正在发送的记录当崩溃。历史记录按数量裁剪会丢去重凭证，亦可能删除未完成 transport ACK 的记录。
5. 本地未决通知被 Cloud 接管时，旧实现可能新建 pending 消息，改变页面去重身份；必须保留原 message key 并分开正式 Cloud ACK key。
6. 独立审查发现 same-key 本地记录的 Cloud adoption 分支未切换 Cloud 元数据，导致不进入 ACK 队列；已修复，并覆盖正式 key 的即时 ACK。
7. 仅 uncertain reconcile 有界不足以满足要求；pending delivery 与 ACK-only 重试也需要次数/时间边界，触界保留记录并明确人工处理。
8. 原指纹未覆盖 Bootstrap、coordinator 和 native execution 等关键源码。已经扩展源码覆盖，但旧指纹与新指纹算法不同，不能直接比较来断言回滚。

## 最终投递架构与实际保证

- Bootstrap 只通过只读 health probe 检查浏览器/CDP；`healthState` 与每条投递事实分离。对健康探测有硬 deadline，离线周期最多启动一次，不导航既有任务聊天。heartbeat readiness 的 scope 是 transport，不能代表某目标已登录、输入框有效或消息已送达。
- Delivery 优先使用结构校验并冻结的 `wake_target`。无目标标签时创建独立标签，禁止把其他聊天导航成目标。只有明确 legacy binding 才使用旧全局目标，不推测来源 URL。
- 同进程按 CDP 端口共享发送队列；使用同一官方 Outbox 文件的不同进程使用独立 submission 文件锁串行整个提交事务。短读改写锁与长提交锁分开，提交期间的 progress 持久化不会自身死锁。
- 持久阶段为 `queued → draft_verified → submit_attempted → message_visible → transport_acked`。`submit_attempted` 是点击前的 durable intent（写前日志）：它可能存在于后续 guard 阻止真实点击的记录中，不能单凭该字段证明按钮已点击。确认实际投递只认目标会话中的明确用户气泡和完整 project/task/message key 标记。
- 新阶段以白名单布尔诊断及时间记录持久化；旧 Format 1 记录缺少新字段时保留 null/unknown，不伪造历史。进程在提交意图后退出或发生未知错误，保守进入 uncertain；只读 reconcile 检查实际气泡。
- 用户已有草稿、预检后新草稿、落盘期间编辑草稿都会阻止发送。可见性读取失败、主 frame/目标变化、发送控件失效或被遮挡均停止提交；无盲目 Enter。
- 本地通知由 Cloud 接管时保留原页面 key，另存 `cloud_message_key` 进行正式 transport ACK，不因接管重复创建通知。Cloud ACK 重试只重试 ACK，不重复发消息。
- pending send、uncertain reconcile 和 ACK-only 默认每类最多8次，恢复时间窗口24小时；任一边界触达后保留记录并标记 manual，不伪造成功。safe_draft 的自动恢复额外最多一次；即使目标标签缺失，也必须重新可靠检查目标消息后才能提交。
- 原始去重凭证及未完成 ACK 记录不再按2000条裁剪。Windows唯一有效备份保留到新canonical落地；两次崩溃也不丢已落盘凭证。
- `orchestrator_handled` 始终为 null，Connector 无权以 transport ACK 推断 ChatGPT 已消费项目事件。业务消费由实际读取结果、持久化下一步决定和 `ack_project_event` 证明。

当前实际保证是持久去重、提交未决保守保留、有限安全草稿恢复、目标可见后 ACK 和业务幂等。浏览器与 Outbox 没有共享事务，不能承诺端到端 exactly-once，也不保证所有客户端必然被 UI 通知恢复。

## 剩余限制与未知

- 对其他活跃进程复用旧 PID 的情况无法跨平台充分证明身份；发送/ACK保持claimed并在生命周期触界后标记manual，不能危险重发。同PID的不同进程代际用owner token区分。同进程插件重载遗留任务也不能凭新实例就认定崩溃。
- 普通文件锁等待最多10秒，无法安全判定owner时返回busy。若进程恰好崩溃在清理死锁的 `.recovery` guard 阶段，后续fail closed，可能需要人工检查guard；不能自动删锁掩盖所有权不明。锁失败发生在claim前，不计入实际发送attempts。
- 跨进程提交互斥仅覆盖同一个官方Outbox文件。不同Outbox文件共享一个CDP浏览器、外部CDP客户端及人工同时操作不在跨进程互斥保证内；使用不同文件来绕开锁不受支持。
- 进程可能在点击后、落盘前退出；UI 与 Outbox 不共享事务，因此无法承诺端到端 exactly-once。
- CDP 只检查当前加载的目标消息区域，历史消息加载及不同客户端是否恢复编排仍需真机验收。
- 浏览器在最终观察和输入动作间仍可能变化。源码已缩小窗口并fail closed，但UI自动化不能提供平台级事务或保证所有客户端行为。
- 去重凭证不再裁剪，长期Outbox文件会增长；将来需独立持久凭证存储，不能先删历史再宣称永久去重。
- 生产 Site 的来源元数据捕获与 immutable binding 实现不在当前 Connector 仓库中，尚未完成实现级审计。

独立Agent对冻结后的关键路径进行了只读审查，最后一行保护补丁亦签收；在本轮所查路径中没有剩余已证实的代码blocking issue。这不是全面正确性证明，亦不能替代真实验收。

## 测试证据与性质

交付目录：`E:\项目\dw-p0-delivery-20261009-codex`。

| 验证 | 结果 | 证据/性质 |
|---|---|---|
| Bridge/Bootstrap阶段全量 | 349/349通过 | `bridge-bootstrap-349-tests.log`，模拟CDP与本地单元测试 |
| 首次统一集成全量（bf7afa2） | 370/370通过，0失败/跳过/取消 | `unified-tests.log` |
| 最后协议保护补丁合并后定向（e89bd70） | 54/54通过 | `final-protocol-tests.log` |
| 最终统一全量（e89bd70，最终执行源码） | 370/370通过，0失败/跳过/取消，约45.4秒 | `final-unified-tests.log`；后续候选提交仅补交付文档，执行源码与该测试快照相同 |
| 进程退出/互斥/备份恢复 | 真实测试子进程已覆盖 | 双进程提交最大并发1、三个进程并发写入、提交意图后退出、唯一备份二次崩溃；浏览器仍是模拟 |
| 真实浏览器、真实通知气泡 | 未执行 | 没有安装后的真实消息证据 |
| ChatGPT读取结果及业务ACK | 未执行 | 核心闭环尚未验收 |

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

1. 阅读本文与 `docs/p0-platform-boundaries.md`，核对交付目录 `candidate-receipt.json` 的候选SHA、源码指纹和测试日志；重新查看git状态，不重做已经完成的A/B/C集成。
2. 本地代码已集成、定向与独立审查完成；最终统一测试及候选包的状态以receipt为准。若缺少receipt，先完成这一收尾，不把阶段性结果认定为最终构建。
3. 候选提交尚未push，未创建远程发布。不要尝试从官方GitHub安装一个尚不可获取的本地SHA。先确认官方Manager如何获取这一精确个人试用候选；未经用户授权，不采用裸覆盖或隐式发布。
4. 包来自固定提交快照。源码指纹按实际字节计算，Git工作树CRLF与归档LF可能有不同值；以安装的精确包字节对应指纹比较，不能把换行差异直接断言为代码回滚。源码版本、磁盘字节、模块加载时冻结的运行指纹仍必须分别核对。
5. 取得官方安装入口后，先备份 Connector、profile 配置/lock 和 Outbox；安装精确候选提交。记录结果并让用户在任务结束后重启。
6. 核对 loaded commit/build fingerprint 与候选包一致，再在新 Project 中绑定用户确认的专用聊天，发唯一任务/MESSAGE_KEY。任务提交后结束编排回合，不让 ChatGPT 持续轮询。
7. 保存真实气泡、transport ACK、实际读取结果、后续决定和 `ack_project_event` 的证据。缺少第二聊天则真实 A/B 门槛仍未通过。

## 回滚原则

安装前备份必须成功并记录文件哈希。备份不得输出配置秘密、cookie、token 或聊天正文。候选失败时停止新领取，保留当前 Outbox 与未处理事件；先 reconcile，不盲目恢复陈旧 Outbox 快照覆盖后来状态。通过官方 Manager 恢复精确旧构建，让用户重启后核对 loaded fingerprint。必要的 Outbox 格式迁移必须保留 message key、target 和 ACK 证据。

## 发布结论

**当前 NO-GO。** 本地代码与模拟验证已显著完善，但官方安装、安装后的真实运行证明和真实消费闭环尚未通过，也没有第二个真实聊天用于A/B验收。模拟全绿不能改变此结论，直到真实验收证据补齐。
