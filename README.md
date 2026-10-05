# DeepSeek Worker Connector

DeepSeek Harness 原生本地 Worker Connector。当前正式版本：**0.3.1**。

0.3.1 普通用户路径：首次从受信任 GitHub 地址安装，选择 Harness Workspace 并完成 ChatGPT 设备配对；以后 Connector 自动检查正式版本，并通过 Harness 官方 Plugin Manager 更新自己。更新安装完成后只需要重启 DeepSeek Harness。

普通用户不再需要删除插件、重新输入 GitHub 地址、重新配置 Workspace/Token 或重新设备配对。

## 自动更新

默认：

    autoUpdate: true
    updateChannel: stable

Harness 启动约 20 秒后检查一次；长时间运行时最多每 6 小时检查一次。

普通 UI 底部显示当前版本、自动更新开关、stable/preview 通道和更新状态。状态包括：

    idle
    checking
    up-to-date
    available
    waiting-idle
    installing
    restart-required
    failed

成功安装后提示“已自动安装新版本，重启 DeepSeek Harness 后生效”。当前没有面向第三方插件的通用 Desktop restart/relaunch API，因此 Connector 不使用 taskkill、Stop-Process、kill 或 Electron 私有接口强制重启。

## Update Provider

Provider 顺序：

1. 固定 Cloud manifest：https://deepseek-worker.sxfdgan.chatgpt.site/api/connector/latest
2. 如果接口尚未部署、返回 404/405/501/5xx 或网络不可用，则 fallback 到固定仓库的 GitHub Releases / Tags。

本版本不修改 Cloud。未来 Cloud 只需要实现上述 endpoint。

允许的 manifest 字段只有：

    version
    channel
    source
    ref
    minimumHarnessVersion
    mandatory
    notes

额外字段（例如 command、script、shell）直接拒绝。

可信 source 固定为：

    https://github.com/aevyrian/deepseek-worker.git

stable 只接受无 prerelease 标记的合法 SemVer；preview 可以接收 preview 或 stable。降级、同版本和非法 SemVer 都不安装。

正式 tag（例如 v0.3.2）会先通过 GitHub tag ref 解析为 40 位 commit SHA，再读取该 commit 的 package.json，验证 package name、version 和 Harness bundle metadata。真正交给 Harness 的 spec 是：

    https://github.com/aevyrian/deepseek-worker.git#<exact-commit-sha>

所以自动更新不会跟踪 main 或任意 branch。

## Harness 官方更新机制

Connector 不自己修改 node_modules、Profile package.json 或 pnpm-lock.yaml。只调用当前 Profile 的官方 Host service：

    ctx.pluginManager.listBundles()
    ctx.pluginManager.installBundle(spec, { enabled: false })

listBundles() 先确认正在运行的 package “deepseek-worker-connector”确实来自受信任 GitHub source。

Harness 当前 Plugin Manager 对已安装同名 package replacement 的官方行为是：

- package operation 由 Harness 自己执行；
- bundle 与 Harness compatibility 由 Harness 自己验证；
- 替换成功返回 restart-required；
- 当前旧 fiber / JS generation 不热替换；
- package run 失败/取消，以及 bundle/compatibility 验证失败，会恢复事务前的 profile manifest 和 lockfile。

使用 enabled:false 是为了不重新改写已经存在的 bundle selection，只替换 dependency package。

## Worker 空闲保护

更新流程：

    checking
    -> available
    -> waiting-idle
    -> installing
    -> restart-required

Worker 正在 claim、执行/续写 Harness Session、处理 lease、上传 result 或 failure 时，更新器等待。进入 waiting-idle 后不再开始新的 claim；当前任务完全结束后才进入 installing。

更新落盘后、Harness 重启前，旧 Connector 继续运行，这是官方 package replacement 的预期行为。

## 配置、Token 与 Session 保留

Updater 不写这些存储：

- LOCAL_WORKER_TOKEN / Harness Credentials
- authorizedWorkspaceIds
- trustedWorkspaceMode
- endpoint
- workerId
- pairing identity
- Workspace registry
- Native Session persistence
- continue/rework Session data

Plugin Manager 替换的是 package dependency；这些数据属于 Profile、Credentials provider 或 Harness persistence，不在 Connector package 目录内。

## ChatGPT 配对

原有一键连接继续保留：

    保存配置
    -> Host 生成 Worker Token
    -> Harness Credentials.set()
    -> Cloud pair/start 只接收 token_hash
    -> 打开 approvalUrl
    -> pairingStatus polling
    -> paired

Browser 不读取保存后的 Token，也不把 Token 写 URL、Local Storage、Session Storage、Clipboard 或日志。

## Workspace 与 Native Session

本轮没有重构 ctx.workspaces、ctx.workspaceRegistry、authorizedWorkspaceIds、trustedWorkspaceMode、Native Session、continue/rework 或 Cloud 本地路径注入拒绝。

## 安装

正常安装应让 Harness 记录受信任 Git source：

    https://github.com/aevyrian/deepseek-worker.git

仓库 install.ps1 默认也使用该 source，并通过官方 dsh plugin --profile ... add ... 做首次安装。

开发者 file:/本地路径安装不会被自动迁移成远端 package；自动更新会安全拒绝非受信任安装源。

更完整设计见 docs/UPDATE.md。
