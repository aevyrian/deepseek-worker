# Dual-mode Orchestration — 0.6.0 legacy

The 0.6.0 Cloud Orchestrator design used the OpenAI Responses API as a fallback.
It was removed from the active architecture in 0.7.0 because the project now
follows a free-first requirement.

Do not configure or depend on `OPENAI_API_KEY` for DeepSeek Worker
orchestration.

Current design:

- Native MCP Events when the ChatGPT host subscribes.
- Local Chat Bridge as the free fallback.
- No paid OpenAI API fallback.

See [FREE-DUAL-CHANNEL.md](FREE-DUAL-CHANNEL.md).
