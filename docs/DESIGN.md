# DeepSeek Worker Connector 设计思路

本文档记录本项目的架构边界、关键决策和后续演进原则。

## 1. 核心目标

目标不是简单“让 ChatGPT 调用 DeepSeek”，而是建立三层协作：

```text
GPT / ChatGPT
负责理解目标、拆任务、验收

DeepSeek Worker Cloud
负责持久化、路由、Cloud DeepSeek、任务状态

DeepSeek Harness Local
负责真实代码、文件、命令、Git、测试和本地工具
```

最终用户只需要在 ChatGPT 中描述目标，不需要手工复制 Prompt，也不需要手工搬运结果。

## 2. 为什么云端和本地必须分开

云端适合：

- 长文本生成
- 独立分析
- 批处理
- 第二模型 Review
- 不依赖本地环境的任务

本地 Harness 适合：

- 读取真实项目
- 修改文件
- Shell
- Git
- 构建与测试
- 复用已有 Session
- 使用本地 Provider 和本地工具

所以采用 Cloud + Local 双执行器，而不是强行把所有能力塞到一边。

## 3. 为什么插件优于独立 Worker 进程

旧架构：

```text
node worker.js
   ↓
轮询 Cloud
   ↓
spawn dsh headless
```

问题是 Session 生命周期由外围脚本间接管理，continue/rework 很难自然恢复原 Harness 会话，而且还要额外维护常驻进程。

新架构：

```text
DeepSeek Harness
   └─ DeepSeek Worker Connector
       ├─ ctx.credentials
       ├─ ctx.sessionController
       ├─ lifecycle
       └─ worker protocol
```

插件跟随 Harness profile 生命周期，因此更适合成为真正的 Local Worker。

## 4. Session 是整个设计的核心

云端任务 ID 和本地 Harness Session 必须显式绑定：

```text
task_123
   ↕
session_abc
```

首次任务创建 Session 并回传 `session_bound`；后续 continue / rework 必须恢复原 Session。

如果恢复失败，应该明确返回错误，而不是静默创建一个空会话。

## 5. Workspace 不是远程路径

Cloud 不应该知道本机真实目录。

Cloud 只知道：

```text
workspace_id = novel
```

本地 Connector 保存：

```text
novel → E:/项目/deep
```

这样可以做到：

- Cloud 无法扫描任意目录
- 换电脑后只改本地映射
- 云端任务不依赖 Windows 盘符

默认 allowlist 为空，即插件安全暂停。

## 6. Worker 协议

本地插件主动出站访问 Cloud：

```text
POST /api/worker/register
POST /api/worker/heartbeat
POST /api/worker/claim
POST /api/worker/lease/renew
POST /api/worker/events
POST /api/worker/result
POST /api/worker/failure
```

认证：

```text
Authorization: Bearer <LOCAL_WORKER_TOKEN>
```

本机不开放监听端口。

### 为什么采用 claim + lease

本地电脑可能睡眠、断网、重启或长时间执行任务。Lease 可以避免任务因为 Worker 消失而永久卡死。

## 7. 原生 Session 与 fallback

主路径：

```text
ctx.sessionController
```

兼容路径：

```text
dsh --profile headless --json
```

fallback 只用于当前 profile 缺少 Session Controller 或 Harness API 发生兼容性变化，不能反过来成为默认主路径。

## 8. 凭据设计

Connector 使用 Harness credentials 读取：

```text
LOCAL_WORKER_TOKEN
```

原则：

- Secret 不进入 Git
- Secret 不进入 bundle patch
- Secret 不进入日志
- Secret 不进入 Cloud task payload
- Cloud DeepSeek API Key 与 Local Worker Token 分离

## 9. Auto / Cloud / Local / Hybrid

### cloud

适合不依赖本地环境的大文本和分析任务。

### local

适合本地 Workspace、Shell、Git 或 Harness Session。

### hybrid

推荐复杂工程任务：

```text
GPT
 ↓
Cloud DeepSeek 分析
 ↓
Local Harness 实施
 ↓
Cloud DeepSeek Review
 ↓
Local Harness 修复
 ↓
GPT 最终验收
```

### auto

由路由器根据任务能力自动决定。

## 10. GPT 不是简单转发器

最终系统里 GPT 应保留：

- 用户意图理解
- 任务拆解
- 关键架构决策
- 风险判断
- 结果验收
- 返工决策

DeepSeek Worker 更像“执行资源池”，而不是替代 GPT 的总控。

## 11. 错误必须显式

不允许静默降级：

- Session 找不到 → 明确恢复失败
- Workspace 未授权 → 明确拒绝
- Worker Token 错误 → 401/403
- lease 丢失 → 不提交结果
- Session Controller 不兼容 → 明确切换 fallback 或失败
- Cloud 协议版本不兼容 → 拒绝注册

“看起来完成”比明确失败更危险。

## 12. GitHub 作为唯一源码真相

本仓库应成为 Local Connector 唯一正式源码来源。

原因：

- Work 临时环境可能丢失
- ZIP 不方便增量更新
- Git commit 可以追溯
- tag 可以回滚
- Harness 官方插件管理支持 Git 地址

建议版本策略：

```text
0.1.0-beta.1   初始插件
0.1.0-beta.2   联调修复
0.1.0          首个稳定版本
0.2.0          协议或能力扩展
```

## 13. 协议版本

后续建议 Worker 注册时增加：

```json
{
  "worker_id": "aevyr-pc",
  "plugin_version": "0.1.0",
  "harness_version": "...",
  "protocol_version": 1,
  "capabilities": {}
}
```

如果 Cloud 与 Connector 的 protocol version 不兼容，应拒绝工作，而不是继续运行未知协议。

## 14. 后续演进方向

- Worker capability negotiation
- 多本机 Worker
- Worker 优先级
- 并发任务槽位
- Session 恢复
- Cloud 断线重连
- cancel
- task events 流式回传
- Git diff / test 结构化结果
- Connector 状态 UI
- Git tag 固定安装
- Cloud / Connector 协议兼容矩阵

这些能力都应该建立在三个稳定边界上：

```text
Task
Session
Workspace
```

只要这三个边界不混乱，系统就容易维护。
