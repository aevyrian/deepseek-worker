import { randomUUID } from "node:crypto";
import { redactSecret } from "./connector-config.mjs";

export async function executeNativeSession(ctx, controller, task, workspace, prompt, signal, timeoutMs) {
  const existingSessionId = task.session_id || task.harness_session_id || null;
  let sessionId;
  let agent;

  if (existingSessionId) {
    await assertExistingSessionMatchesWorkspace(controller, workspace, existingSessionId, signal);
    const resumed = await controller.resolveAgent(existingSessionId);
    if (resumed?.error) throw resumed.error;
    if (!resumed?.agent) throw new Error(`Harness could not resume Session "${existingSessionId}"`);
    sessionId = existingSessionId;
    agent = resumed.agent;
  } else {
    const created = await controller.create({ workspaceId: workspace.id });
    sessionId = created?.sessionId;
    if (!sessionId) throw new Error("Harness Session Controller did not return a session ID");
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved?.error) throw resolved.error;
    if (!resolved?.agent) throw new Error(`Harness could not resolve newly created Session "${sessionId}"`);
    agent = resolved.agent;
  }

  const baselineSeq = agent.session.snapshotEvents().at(-1)?.seq ?? -1;
  const turnAbort = new AbortController();
  const turnSignal = AbortSignal.any([signal, turnAbort.signal]);
  const turn = waitForTurnEnd(ctx, agent, baselineSeq, turnSignal, timeoutMs);
  let promptAccepted = false;
  try {
    await controller.prompt({
      requestId: `deepseek-worker-${randomUUID()}`,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: prompt }],
    }, signal);
    promptAccepted = true;
    await turn;
  } catch (error) {
    turnAbort.abort(error);
    await turn.catch(() => {});
    if (promptAccepted) {
      await Promise.resolve().then(() => controller.cancel({ sessionId })).catch(() => {});
    }
    throw error;
  } finally {
    turnAbort.abort();
  }

  const result = latestAssistantText(agent.session.snapshotEvents(), baselineSeq);
  if (!result) throw new Error("Harness Session finished without an assistant result");
  return { result, sessionId, executor: "harness-native" };
}

export async function assertExistingSessionMatchesWorkspace(controller, workspace, sessionId, signal) {
  if (!workspace.sessionIds.includes(sessionId)) {
    throw new Error(`Session "${sessionId}" is not attached to Harness Workspace "${workspace.id}"`);
  }
  let inspection;
  try {
    inspection = await controller.inspect(sessionId, signal);
  } catch (error) {
    throw new Error(`Session "${sessionId}" could not be inspected or does not exist: ${redactSecret(error)}`);
  }
  const cwd = inspection?.meta?.cwd;
  if (!cwd || cwd !== workspace.path) {
    throw new Error(`Session "${sessionId}" does not belong to the requested Harness Workspace`);
  }
}

export function waitForTurnEnd(ctx, agent, baselineSeq, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let offSession = () => {};
    let offError = () => {};

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      offSession();
      offError();
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(
      signal.reason instanceof Error ? signal.reason : new Error("Harness task aborted"),
    );

    offSession = ctx.on("session/event", (session, event) => {
      if (session !== agent.session || event.seq <= baselineSeq) return;
      if (event.type === "turn/end") finish();
    });
    offError = ctx.on("agent/error", ({ agent: subject, error }) => {
      if (subject !== agent) return;
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    timer = setTimeout(
      () => finish(new Error("Harness Session timed out waiting for turn completion")),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function latestAssistantText(events, baselineSeq) {
  const event = events.findLast((candidate) => (
    candidate.seq > baselineSeq && candidate.type === "assistant/message"
  ));
  if (!event) return "";
  return event.data.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
