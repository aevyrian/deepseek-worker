import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventCore } from "../cloud/event-core.mjs";
import {
  CALLBACK_ERROR_CODE,
  eventsList,
  eventsSubscribe,
  eventsUnsubscribe,
  mergeDiscoverForEvents,
} from "../cloud/mcp-events.mjs";

const OWNER = "owner-1";
const PROJECT = "project-1";
const SECRET = "whsec_" + Buffer.alloc(32, 5).toString("base64");

function coreWithProject() {
  const core = new InMemoryEventCore();
  core.createProject({ projectId: PROJECT, owner: OWNER });
  return core;
}

test("server/discover advertises MCP 2.0 events without dropping existing tools", () => {
  const merged = mergeDiscoverForEvents({
    resultType: "complete",
    supportedVersions: ["2025-06-18"],
    capabilities: { tools: { listChanged: true } },
  });
  assert.ok(merged.supportedVersions.includes("2026-07-28"));
  assert.deepEqual(merged.capabilities.tools, { listChanged: true });
  assert.deepEqual(merged.capabilities.events, {});
});

test("events/list returns the stable catalog", () => {
  const result = eventsList();
  assert.deepEqual(result.events.map((event) => event.name), ["task.completed", "task.failed"]);
  assert.equal(result.nextCursor, null);
});

test("events/subscribe verifies callback before persisting subscription", async () => {
  const core = coreWithProject();
  let observed;
  const response = await eventsSubscribe({
    core,
    principal: OWNER,
    params: {
      name: "task.completed",
      arguments: { project_id: PROJECT },
      delivery: {
        mode: "webhook",
        url: "https://events.example.com/callback",
        secret: SECRET,
      },
      ttlMs: 120_000,
    },
    now: new Date("2026-10-06T10:00:00Z"),
    challengeFactory: () => "challenge-0123456789abcdef",
    webhookFetch: async (url, init) => {
      observed = { url, init };
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async json() { return { challenge: body.challenge }; },
      };
    },
  });

  assert.match(response.id, /^sub_/u);
  assert.equal(observed.url, "https://events.example.com/callback");
  assert.equal(observed.init.redirect, "error");
  assert.match(observed.init.headers["webhook-signature"], /^v1,/u);

  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
  });
  assert.equal(core.dueDeliveries().length, 1);
});

test("events/subscribe does not store a subscription when callback verification fails", async () => {
  const core = coreWithProject();
  await assert.rejects(() => eventsSubscribe({
    core,
    principal: OWNER,
    params: {
      name: "task.completed",
      arguments: { project_id: PROJECT },
      delivery: {
        mode: "webhook",
        url: "https://events.example.com/callback",
        secret: SECRET,
      },
    },
    challengeFactory: () => "challenge-0123456789abcdef",
    webhookFetch: async () => ({
      ok: true,
      status: 200,
      async json() { return { challenge: "wrong-challenge-0000000000" }; },
    }),
  }), (error) => error?.code === CALLBACK_ERROR_CODE && error?.data?.reason === "challenge_failed");

  core.markTaskTerminal({
    projectId: PROJECT,
    taskId: "task-a",
    owner: OWNER,
    status: "completed",
  });
  assert.equal(core.dueDeliveries().length, 0);
});

test("events/subscribe authorizes project ownership before callback traffic", async () => {
  const core = coreWithProject();
  let fetchCalls = 0;

  await assert.rejects(() => eventsSubscribe({
    core,
    principal: "other-owner",
    params: {
      name: "task.completed",
      arguments: { project_id: PROJECT },
      delivery: {
        mode: "webhook",
        url: "https://events.example.com/callback",
        secret: SECRET,
      },
    },
    webhookFetch: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, async json() { return {}; } };
    },
  }), /Project not found/);

  assert.equal(fetchCalls, 0);
});

test("events/unsubscribe is idempotent", async () => {
  const core = coreWithProject();
  const params = {
    name: "task.completed",
    arguments: { project_id: PROJECT },
    delivery: {
      mode: "webhook",
      url: "https://events.example.com/callback",
      secret: SECRET,
    },
  };

  await eventsSubscribe({
    core,
    principal: OWNER,
    params,
    challengeFactory: () => "challenge-0123456789abcdef",
    webhookFetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, async json() { return { challenge: body.challenge }; } };
    },
  });

  assert.deepEqual(eventsUnsubscribe({ core, principal: OWNER, params }), {});
  assert.deepEqual(eventsUnsubscribe({ core, principal: OWNER, params }), {});
});
