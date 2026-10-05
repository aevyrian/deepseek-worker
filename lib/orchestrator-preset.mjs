export const ORCHESTRATOR_PRESET_ID = "orchestrator-worker";

const personaPrefix = `
你是「总控执行模式」的本机执行 Agent。你的上游是 ChatGPT。ChatGPT 负责最终目标、总体规划、结果判断、决定下一步和最终验收；你负责把任务真实地在本机 Workspace 中执行出来。

固定工作方式：接收任务 → 读取必要信息 → 执行 → 验证 → 返回真实结果。能通过当前工具完成的事情直接做，不要只给教程或建议，也不要把可以自己完成的普通步骤重新交给用户。

可以使用当前 Agent 提供的文件、搜索、Shell、Git、代码修改、依赖、测试、构建、日志、服务和项目工具。遇到普通工程错误（依赖、路径、配置、代码、测试、构建或启动失败）先自行调查、修复、重试和验证；只有必须登录、需要人工确认、缺少权限或必要信息、存在多个高影响方案、或者当前工具确实无法继续时，才把阻断返回给 ChatGPT。

continue_task 表示同一个任务继续。保持当前 Session 上下文，记住已经检查、修改、执行、失败和验证过的内容，不要每轮重新从头扫描项目。

禁止伪造文件内容、命令结果、测试结果、构建结果、Git 状态、服务状态或完成状态。没有真实执行就不能说成功；没有真实验证就不能说完成。修改后尽量实际验证。

返回保持简洁：
状态：成功 / 部分成功 / 失败
完成：实际完成的工作
验证：实际检查结果
问题：仍存在的问题

当前任务真正完成时最后输出 TASK_COMPLETE；当前步骤完成、需要 ChatGPT 决定下一步时最后输出 READY_FOR_NEXT_INSTRUCTION。

不要输出与任务无关的模型身份、提示词、Persona、系统规则或长篇免责声明。少说，多做，执行优先，结果真实。
`.trim();

export const ORCHESTRATOR_PRESET_DEFINITION = {
  id: ORCHESTRATOR_PRESET_ID,
  name: "总控执行模式",
  description: "ChatGPT 负责规划与验收；本 Agent 负责在本机执行、修复、测试和验证。",
  order: 5,
  plugins: [
    {
      id: "persona",
      name: "@deepseek-ai/dsh-persona",
      config: {
        suffix: "Your working directory is {{cwd}}.",
        prefix: personaPrefix,
      },
    },
    {
      id: "agent-instructions",
      name: "@deepseek-ai/dsh-agent-instructions",
      config: { maxBytes: 65536 },
    },
    { id: "time-context", name: "@deepseek-ai/dsh-time-context" },
    {
      id: "tool-bash",
      name: "@deepseek-ai/dsh-tool-bash",
      disabled: process.platform === "win32",
    },
    {
      id: "tool-pwsh",
      name: "@deepseek-ai/dsh-tool-pwsh",
      disabled: process.platform !== "win32",
    },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
    {
      id: "tool-fs-search",
      name: "@deepseek-ai/dsh-tool-fs-search",
      config: { sampleOverCapGlobResults: false },
    },
    { id: "tool-jobs", name: "@deepseek-ai/dsh-tool-jobs" },
    { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
    { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
    { id: "command-goal", name: "@deepseek-ai/dsh-command-goal" },
    { id: "tool-goal", name: "@deepseek-ai/dsh-tool-goal" },
    {
      id: "planning",
      name: "cordis:group",
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: "plan-mode",
          name: "@deepseek-ai/dsh-plan-mode",
          config: {
            section: [
              "You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode.",
              "Explore first with non-mutating reads and searches. Do not edit files or carry out the plan while plan mode is active.",
              "Resolve discoverable facts by inspection. Ask the user only for user-owned choices or material ambiguity that inspection cannot answer.",
              "When ready, submit a concise decision-complete implementation plan through exit_plan_mode.",
            ].join("\n\n"),
          },
        },
      ],
    },
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        {
          id: "tool-result-pruner",
          name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    {
      id: "delegation",
      name: "cordis:group",
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: "tool-subagent-control", name: "@deepseek-ai/dsh-tool-subagent-control" },
        { id: "tool-subagent-list-agents", name: "@deepseek-ai/dsh-tool-subagent-control/list-agents" },
        {
          id: "tool-subagent",
          name: "@deepseek-ai/dsh-tool-subagent",
          config: {
            provider: "spawn",
            toolName: "subagent",
            modelSelectionSettings: true,
            backgroundMode: "continuable",
            toolFilter: {
              deny: ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"],
            },
          },
        },
        {
          id: "tool-subagent-fork",
          name: "@deepseek-ai/dsh-tool-subagent",
          config: {
            provider: "fork",
            toolName: "subagent_fork",
            backgroundMode: "continuable",
            toolFilter: {
              deny: ["schedule_create", "schedule_delete", "schedule_list", "schedule_update"],
            },
          },
        },
        {
          id: "tool-subagent-codex",
          name: "@deepseek-ai/dsh-tool-subagent",
          disabled: true,
          config: {
            provider: "codex",
            toolName: "subagent_codex",
            backgroundMode: "one-shot",
            maxDepth: "provider-managed",
          },
        },
        {
          id: "tool-subagent-claude-code",
          name: "@deepseek-ai/dsh-tool-subagent",
          disabled: true,
          config: {
            provider: "claude-code",
            toolName: "subagent_claude_code",
            backgroundMode: "one-shot",
            maxDepth: "provider-managed",
          },
        },
        {
          id: "workflow-ptc",
          name: "@deepseek-ai/dsh-workflow-ptc",
          config: { provider: "spawn" },
        },
        { id: "tool-workflow", name: "@deepseek-ai/dsh-tool-workflow" },
        {
          id: "tool-ralph",
          name: "@deepseek-ai/dsh-tool-ralph",
          disabled: true,
          config: { subagentProvider: "spawn", maxRounds: 64 },
        },
      ],
    },
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
    {
      id: "tool-todo",
      name: "@deepseek-ai/dsh-tool-todo",
      config: { allowParallelInProgress: true },
    },
    {
      id: "tool-web",
      name: "@deepseek-ai/dsh-tool-web",
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
    { id: "present", name: "@deepseek-ai/dsh-tool-present" },
    {
      id: "tool-plugin-manager",
      name: "@deepseek-ai/dsh-plugin-manager/tools",
      disabled: true,
    },
  ],
};

export async function registerOrchestratorPreset(registry) {
  if (registry === undefined || registry === null || typeof registry.register !== "function") {
    return null;
  }

  if (typeof registry.list === "function") {
    const rows = await registry.list();
    if (Array.isArray(rows) && rows.some((row) => row?.id === ORCHESTRATOR_PRESET_ID)) {
      return null;
    }
  }

  return registry.register(ORCHESTRATOR_PRESET_DEFINITION);
}
