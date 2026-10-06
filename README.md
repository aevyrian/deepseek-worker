# DeepSeek Worker

<!--
FRONT-PAGE MAINTENANCE RULE:
The section between FRONT-PAGE-BEGIN and FRONT-PAGE-END is the stable first-contact page for ordinary users.
Routine feature work, bug fixes, refactors, version bumps, release notes, CI changes, updater changes, protocol changes, and AI-generated maintenance MUST NOT rewrite, replace, expand, or move that section.
Only change it when the repository owner explicitly asks to change the public landing page, installation steps, onboarding flow, or end-user usage.
Do not insert implementation details or release notes above FRONT-PAGE-END.
-->

<!-- FRONT-PAGE-BEGIN -->

让 **ChatGPT 直接连接你电脑上的 DeepSeek Harness**，把本地项目任务交给 Harness 执行，再把真实结果返回给 ChatGPT 继续判断和下达下一步。

你可以把它理解成：

> ChatGPT 负责想、安排和验收，DeepSeek Harness 负责在你的电脑上真正执行。

适合用来做这些事情：

- 启动项目、排查报错、修改代码。
- 执行 PowerShell / Shell、Git、测试、构建等本地任务。
- 在同一个 Harness Session 里连续执行多轮任务。
- 让 ChatGPT 根据上一轮真实结果继续下达下一步。
- 在任务真正完成后，再由 ChatGPT 给你最终结果。

Connector 自带 **「总控执行模式」**。插件启用时会自动把它注册到 Harness 的预设列表；ChatGPT 远程 Worker 任务也会自动采用同样的总控执行规则，普通用户不需要自己创建 Agent Preset。

## 安装前准备

你需要：

- 已安装并能正常使用 **DeepSeek Harness**。
- Harness 中至少已经有一个 **Workspace**。
- 一个可以正常登录的 **ChatGPT** 账号。

## 安装

推荐直接从 DeepSeek Harness 的插件页面安装。

1. 打开 DeepSeek Harness。
2. 进入 **插件**。
3. 点击 **添加插件**。
4. 粘贴下面这个 GitHub 地址：

```text
https://github.com/aevyrian/deepseek-worker.git
```

5. 点击 **安装**。
6. 安装完成后点击 **立即启用**。
7. 如果 Harness 提示需要重启，就重启一次。

安装完成后，你应该能在插件列表中看到 **DeepSeek Worker Connector**。

## 第一次连接 ChatGPT

1. 打开 **DeepSeek Worker Connector** 的设置。
2. 在 **授权 Workspace** 中勾选你允许 ChatGPT 使用的项目。
3. 保存配置。
4. 点击 **安装并连接 ChatGPT**。
5. 浏览器会打开连接页面，登录 ChatGPT 并确认连接。
6. 回到 Harness，看到状态为 **已连接** 即可。

正常情况下，你不需要手工复制 Token，也不需要填写 Cloud 地址或 Worker ID。

## 怎么使用

连接成功后，直接在 ChatGPT 里描述你最终想要的结果。

例如：

> 帮我把这个项目启动起来。先检查为什么报错，能修的直接修，跑测试确认，直到能正常启动以后再告诉我。

典型工作流程是：

```text
你提出目标
→ ChatGPT 判断下一步
→ DeepSeek Worker 把任务发给本机 Harness
→ Harness 实际执行
→ 结果返回 ChatGPT
→ ChatGPT 根据结果继续下达任务
→ 完成后告诉你最终结果
```

你不需要每一步都自己复制命令，也不需要每轮都重新创建 Harness 会话。

## 总控执行模式

Connector 已经内置：

```text
总控执行模式
Preset ID: orchestrator-worker
```

它专门用于 ChatGPT → DeepSeek Worker → DeepSeek Harness 这条执行链。

这个模式的职责很简单：

- ChatGPT 负责目标、规划、判断和最终验收。
- Harness Agent 负责读取文件、修改代码、执行命令、测试、构建、调试和验证。
- 普通工程错误优先由本地 Agent 自己检查、修复和重试。
- 同一任务的后续指令会继续原来的 Session，不会每轮重新开始。

你不需要手工创建这个模式，也不需要在创造模式里粘贴任何提示词。停用或卸载 Connector 时，这个预设会随插件生命周期自动注销，因此不会再阻止插件卸载；重新安装并启用 Connector 后会自动恢复。

## 更新

Connector 支持自动更新。

普通用户保持默认的 **正式版** 更新通道即可。

如果想提前测试正在开发的新功能，可以在 Connector 设置中切换到 **测试版**。

更新安装完成后，如果界面提示需要重启 Harness，重启一次即可。Workspace 授权和设备连接不需要重新配置。

## 常见问题

**安装后没有看到插件？**  
先确认安装完成后点了 **立即启用**。如果 Harness 提示需要重启，就重启一次。

**连接按钮提示没有 Workspace？**  
先在 Harness 中创建一个 Workspace，再回到 Connector 设置里勾选它。

**浏览器打开连接页面正常吗？**  
正常。第一次连接需要在浏览器里登录 ChatGPT 并确认这台设备。

**已经连接过，重启 Harness 后还要重新连接吗？**  
正常情况下不需要。Connector 会恢复原来的设备连接。

**更新后显示需要重启？**  
重启 DeepSeek Harness 即可，不需要卸载重装。

<!-- FRONT-PAGE-END -->

## 项目状态

当前仍在持续开发和真机验证中。版本变化、修复内容和测试记录请看 [CHANGELOG.md](CHANGELOG.md)。

## 开发与维护文档

普通用户不需要阅读下面这些内容：

- [CHANGELOG.md](CHANGELOG.md) — 版本变化
- [docs/UPDATE.md](docs/UPDATE.md) — 更新机制
- [docs/CLOUD-PAIRING.md](docs/CLOUD-PAIRING.md) — Cloud 配对协议
- [docs/CLOUD-EVENTS.md](docs/CLOUD-EVENTS.md) — MCP Events / Project State
- [docs/DUAL-MODE-ORCHESTRATION.md](docs/DUAL-MODE-ORCHESTRATION.md) — Native Events 优先 + Cloud Orchestrator fallback
