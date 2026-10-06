import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  buildSignedHeaders,
  sendSignedWebhook,
  signStandardWebhook,
  verifyCallbackChallenge,
} from "../cloud/webhooks.mjs";

const KEY = Buffer.alloc(32, 9);
const SECRET = "whsec_" + KEY.toString("base64");
const SUBSCRIPTION = {
  id: "sub_example",
  callback_url: "https://events.example.com/callback",
  secret: SECRET,
};

test("Standard Webhooks signature signs id.timestamp.exact-body with HMAC-SHA256", () => {
  const body = '{"eventId":"evt_1","data":{"x":1}}';
  const timestamp = new Date("2026-10-06T10:00:00Z");
  const signed = signStandardWebhook(SECRET, {
    id: "evt_1",
    timestamp,
    body,
  });
  const seconds = Math.floor(timestamp.getTime() / 1000);
  const expected = createHmac("sha256", KEY)
    .update(`evt_1.${seconds}.${body}`)
    .digest("base64");

  assert.equal(signed.timestamp, seconds);
  assert.equal(signed.signature, `v1,${expected}`);
});

test("signed headers support a temporary old+new secret rotation window", () => {
  const previousSecret = "whsec_" + Buffer.alloc(32, 3).toString("base64");
  const headers = buildSignedHeaders(SECRET, {
    id: "evt_1",
    timestamp: new Date("2026-10-06T10:00:00Z"),
    body: "{}",
    subscriptionId: SUBSCRIPTION.id,
    previousSecret,
  });

  assert.equal(headers["webhook-id"], "evt_1");
  assert.equal(headers["X-MCP-Subscription-Id"], SUBSCRIPTION.id);
  assert.equal(headers["webhook-signature"].split(" ").length, 2);
  assert.match(headers["webhook-signature"], /^v1,/u);
});

test("sendSignedWebhook signs and sends exactly the serialized body once", async () => {
  const calls = [];
  const payload = {
    eventId: "evt_123",
    name: "task.completed",
    timestamp: "2026-10-06T10:00:00Z",
    data: { project_id: "p1", task_id: "t1" },
    cursor: null,
  };
  const result = await sendSignedWebhook({
    subscription: SUBSCRIPTION,
    payload,
    now: new Date("2026-10-06T10:01:00Z"),
    webhookFetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 202 };
    },
  });

  assert.deepEqual(result, { accepted: true, status: 202 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, SUBSCRIPTION.callback_url);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.body, JSON.stringify(payload));
  assert.equal(calls[0].init.headers["webhook-id"], payload.eventId);
  assert.match(calls[0].init.headers["webhook-signature"], /^v1,/u);
});

test("sendSignedWebhook rejects event bodies larger than 256 KiB", async () => {
  await assert.rejects(() => sendSignedWebhook({
    subscription: SUBSCRIPTION,
    payload: {
      eventId: "evt_big",
      data: "x".repeat(256 * 1024),
    },
    webhookFetch: async () => ({ ok: true, status: 200 }),
  }), /256 KiB/);
});

test("callback verification requires an exact echoed challenge", async () => {
  const challenge = "challenge-0123456789abcdef";
  const calls = [];
  const result = await verifyCallbackChallenge({
    subscription: SUBSCRIPTION,
    challenge,
    verificationId: "msg_verification_1",
    now: new Date("2026-10-06T10:00:00Z"),
    webhookFetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() { return { challenge }; },
      };
    },
  });

  assert.equal(result.verified, true);
  assert.equal(result.verificationId, "msg_verification_1");
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { type: "verification", challenge });
  assert.equal(calls[0].init.headers["webhook-id"], "msg_verification_1");
});

test("callback verification rejects a mismatched challenge", async () => {
  await assert.rejects(() => verifyCallbackChallenge({
    subscription: SUBSCRIPTION,
    challenge: "challenge-0123456789abcdef",
    verificationId: "msg_verification_2",
    webhookFetch: async () => ({
      ok: true,
      status: 200,
      async json() { return { challenge: "different-0123456789abcdef" }; },
    }),
  }), (error) => error?.reason === "challenge_failed");
});

test("callback verification categorizes HTTP failure", async () => {
  await assert.rejects(() => verifyCallbackChallenge({
    subscription: SUBSCRIPTION,
    challenge: "challenge-0123456789abcdef",
    verificationId: "msg_verification_3",
    webhookFetch: async () => ({ ok: false, status: 500 }),
  }), (error) => error?.code === "CallbackEndpointError" && error?.reason === "http_error");
});
