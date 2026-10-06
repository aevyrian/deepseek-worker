import { randomBytes } from "node:crypto";

import {
  EVENT_CATALOG,
  MCP_PROTOCOL_VERSION,
  deriveSubscriptionId,
  normalizeSubscriptionArguments,
  validateCallbackUrl,
  validateWebhookSecret,
} from "./event-core.mjs";
import { verifyCallbackChallenge } from "./webhooks.mjs";

export const CALLBACK_ERROR_CODE = -32015;

function subscriptionCandidate({ principal, name, arguments: args, delivery }) {
  if (!delivery || delivery.mode !== "webhook") {
    throw new Error("Only webhook delivery is supported");
  }
  const callbackUrl = validateCallbackUrl(delivery.url);
  const secret = validateWebhookSecret(delivery.secret);
  const normalizedArgs = normalizeSubscriptionArguments(name, args);
  const id = deriveSubscriptionId({
    principal,
    callbackUrl,
    name,
    arguments: normalizedArgs,
  });
  return {
    id,
    principal,
    name,
    arguments: normalizedArgs,
    project_id: normalizedArgs.project_id,
    callback_url: callbackUrl,
    secret,
  };
}

export function mergeDiscoverForEvents(discover = {}) {
  const versions = new Set(Array.isArray(discover.supportedVersions) ? discover.supportedVersions : []);
  versions.add(MCP_PROTOCOL_VERSION);
  return {
    ...discover,
    resultType: discover.resultType || "complete",
    supportedVersions: [...versions],
    capabilities: {
      ...(discover.capabilities || {}),
      tools: { ...(discover.capabilities?.tools || {}) },
      events: { ...(discover.capabilities?.events || {}) },
    },
  };
}

export function eventsList({ cursor = null } = {}) {
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    throw new Error("Event catalog does not currently paginate");
  }
  return {
    events: EVENT_CATALOG.map((event) => structuredClone(event)),
    nextCursor: null,
  };
}

export async function eventsSubscribe({
  core,
  principal,
  params,
  webhookFetch,
  now = new Date(),
  challengeFactory = () => randomBytes(24).toString("base64url"),
}) {
  if (!core || typeof core.subscribe !== "function" || typeof core.getProject !== "function") {
    throw new Error("Event store is unavailable");
  }
  if (!params || typeof params !== "object") throw new Error("events/subscribe params are required");
  const candidate = subscriptionCandidate({
    principal,
    name: params.name,
    arguments: params.arguments,
    delivery: params.delivery,
  });

  // Authorization happens before any callback traffic.
  const project = core.getProject(candidate.project_id, principal);
  if (!project) throw new Error("Project not found");

  const challenge = String(challengeFactory());
  try {
    await verifyCallbackChallenge({
      subscription: candidate,
      webhookFetch,
      challenge,
      now,
    });
  } catch (error) {
    const wrapped = new Error("Callback endpoint verification failed");
    wrapped.code = CALLBACK_ERROR_CODE;
    wrapped.data = {
      reason: error?.reason || (error?.name === "AbortError" ? "timeout" : "challenge_failed"),
    };
    throw wrapped;
  }

  return core.subscribe({
    principal,
    name: params.name,
    arguments: params.arguments,
    delivery: params.delivery,
    ttlMs: params.ttlMs === undefined ? 24 * 60 * 60_000 : params.ttlMs,
    now,
  });
}

export function eventsUnsubscribe({
  core,
  principal,
  params,
}) {
  if (!core || typeof core.unsubscribe !== "function") throw new Error("Event store is unavailable");
  if (!params || typeof params !== "object") throw new Error("events/unsubscribe params are required");
  return core.unsubscribe({
    principal,
    name: params.name,
    arguments: params.arguments,
    delivery: params.delivery,
  });
}

export async function handleMcpEventMethod({
  method,
  params,
  core,
  principal,
  webhookFetch,
  discover,
  now = new Date(),
  challengeFactory,
}) {
  switch (method) {
    case "server/discover":
      return mergeDiscoverForEvents(discover);
    case "events/list":
      return eventsList(params);
    case "events/subscribe":
      return eventsSubscribe({
        core,
        principal,
        params,
        webhookFetch,
        now,
        challengeFactory,
      });
    case "events/unsubscribe":
      return eventsUnsubscribe({ core, principal, params });
    default:
      return null;
  }
}
