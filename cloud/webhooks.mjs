import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const SECRET_PREFIX = "whsec_";
const MAX_BODY_BYTES = 256 * 1024;

function decodeSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith(SECRET_PREFIX)) {
    throw new Error("Standard Webhooks secret must start with whsec_");
  }
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Standard Webhooks secret must be valid base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength < 24 || key.byteLength > 64) {
    throw new Error("Standard Webhooks secret must decode to 24-64 bytes");
  }
  return key;
}

function unixSeconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  const millis = date.getTime();
  if (!Number.isFinite(millis)) throw new Error("Invalid webhook signing timestamp");
  return Math.floor(millis / 1000);
}

export function signStandardWebhook(secret, {
  id,
  timestamp,
  body,
}) {
  if (typeof id !== "string" || !id || id.includes(".")) {
    throw new Error("webhook id must be non-empty and must not contain dots");
  }
  if (typeof body !== "string") throw new Error("webhook body must be the exact serialized string");
  const seconds = unixSeconds(timestamp);
  const key = decodeSecret(secret);
  const signature = createHmac("sha256", key)
    .update(`${id}.${seconds}.${body}`)
    .digest("base64");
  return {
    timestamp: seconds,
    signature: `v1,${signature}`,
  };
}

export function buildSignedHeaders(secret, {
  id,
  timestamp,
  body,
  subscriptionId,
  previousSecret = null,
}) {
  const current = signStandardWebhook(secret, { id, timestamp, body });
  let signature = current.signature;
  if (previousSecret) {
    const previous = signStandardWebhook(previousSecret, { id, timestamp, body });
    signature = `${current.signature} ${previous.signature}`;
  }
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(current.timestamp),
    "webhook-signature": signature,
    "X-MCP-Subscription-Id": subscriptionId,
  };
}

export async function sendSignedWebhook({
  subscription,
  payload,
  webhookFetch,
  now = new Date(),
  timeoutMs = 10_000,
  previousSecret = null,
}) {
  if (typeof webhookFetch !== "function") {
    throw new Error("webhookFetch is required and must enforce public-address validation and redirect blocking");
  }
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error("Event payload exceeds 256 KiB");
  }
  const id = payload?.eventId || payload?.id;
  if (typeof id !== "string" || !id) throw new Error("Webhook payload requires eventId or id");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Webhook delivery timed out")), timeoutMs);
  try {
    const response = await webhookFetch(subscription.callback_url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: buildSignedHeaders(subscription.secret, {
        id,
        timestamp: now,
        body,
        subscriptionId: subscription.id,
        previousSecret,
      }),
      body,
    });
    return { accepted: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyCallbackChallenge({
  subscription,
  webhookFetch,
  challenge,
  verificationId = `msg_verification_${randomUUID()}`,
  now = new Date(),
  timeoutMs = 10_000,
}) {
  if (typeof webhookFetch !== "function") {
    throw new Error("webhookFetch is required and must enforce public-address validation and redirect blocking");
  }
  if (typeof challenge !== "string" || challenge.length < 16 || challenge.length > 512) {
    throw new Error("verification challenge must be a 16-512 character string");
  }
  const body = JSON.stringify({ type: "verification", challenge });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Callback verification timed out")), timeoutMs);
  try {
    const response = await webhookFetch(subscription.callback_url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: buildSignedHeaders(subscription.secret, {
        id: verificationId,
        timestamp: now,
        body,
        subscriptionId: subscription.id,
      }),
      body,
    });
    if (!response.ok) {
      const error = new Error(`Callback verification returned HTTP ${response.status}`);
      error.code = "CallbackEndpointError";
      error.reason = response.status === 408 ? "timeout" : "http_error";
      throw error;
    }

    let parsed;
    try { parsed = await response.json(); } catch {
      const error = new Error("Callback verification response was not JSON");
      error.code = "CallbackEndpointError";
      error.reason = "challenge_failed";
      throw error;
    }
    const echoed = typeof parsed?.challenge === "string" ? parsed.challenge : "";
    const expectedBytes = Buffer.from(challenge);
    const echoedBytes = Buffer.from(echoed);
    const same = expectedBytes.length === echoedBytes.length
      && timingSafeEqual(expectedBytes, echoedBytes);
    if (!same) {
      const error = new Error("Callback verification challenge did not match");
      error.code = "CallbackEndpointError";
      error.reason = "challenge_failed";
      throw error;
    }
    return { verified: true, verificationId };
  } finally {
    clearTimeout(timer);
  }
}
