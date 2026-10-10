# 0.7.14 — 任务通知与无空白页启动（预发布 prerelease）

> **这是预发布版本，不是稳定版，对稳定通道 NO-GO。**
> 真实端到端验收仍未完成：未观察到真实目标对话收到消息、未观察到真实 ChatGPT 结果被消费、
> 未观察到真实 `ack_project_event` 确认。本版本的依据是 416/416 模拟测试通过。

## 发行标识

| 项目 | 值 |
| --- | --- |
| 包名 | `deepseek-worker-connector` |
| 版本 | `0.7.14` |
| 基于 | `0.7.13`（`70acb74051a7d5c649c15abf08f2d3e4f734e76a`） |
| 上一稳定版 | `0.7.12`（`5b9f7639de8944cc5940ea24cda795535be113f2`） |

## 相对 0.7.13 的变化

| 内容 | 来源提交 |
| --- | --- |
| 已完成任务的本地持久化通知 | `caf3dba55e0f44629401b5c85e8fbf72f8abe6ba` |
| “保存绑定”按钮与任务通知中心界面 | `fbb4b750d9e9c9a6185292d6d6ce835b5404643d` |
| CDP 浏览器启动于 ChatGPT 首页，不再打开 `about:blank` | `2315883d2fd3c9f20abc8826a6c8ce312e533d75` |

0.7.13 的全部 P0 可靠性行为保持不变。

## 测试状态

- `node --test tests/*.test.mjs` —— **416 通过 / 0 失败 / 0 跳过**（0.7.13 为 370）。
- 真实浏览器验收、真实目标对话投递、ChatGPT 结果消费与 `ack_project_event`：**未验证**。

## 暂缓

- `6c19df6`（无需全局绑定即在 ready 时唤醒）与 0.7.13 的 Bootstrap 逻辑存在语义冲突，将单独重写。
- tab-isolation 的未提交改动不包含在内。

## 安装与回滚

仅通过官方 Harness Plugin Manager（`dsh plugin --profile desktop`）从对应 tag 安装，安装后必须重启 Harness。
保留 Connector、profile、配置与 Outbox 备份；不得清空 Outbox，不得重发待处理的 `[DSW]` 消息。
回滚目标：`v0.7.13`（预发布）或 `v0.7.12`（最近稳定版）。