import { describe, it, expect } from "vitest";
import { Webhooks, verifyWebhookSignature, parseWebhookEvent } from "./webhooks.js";
import type { HttpClient } from "./http.js";
import type { WebhookConfig } from "./types.js";

function cfg(over: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    object: "webhook",
    url: "https://app.example/hooks/xtrace",
    events: ["memory.learning.completed", "memory.learning.failed"],
    enabled: true,
    secret: "whsec_examplesecret",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    ...over,
  };
}

function fakeHttp(handler: (method: string, path: string, body: unknown) => unknown): {
  http: HttpClient;
  calls: Array<{ method: string; path: string; body: unknown; query: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown; query: unknown }> = [];
  const http = {
    request: async (
      method: string,
      path: string,
      options: { body?: unknown; query?: unknown } = {},
    ) => {
      calls.push({ method, path, body: options.body, query: options.query });
      return { body: handler(method, path, options.body), status: 200, requestId: "req_test" };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("Webhooks", () => {
  it("set PUTs to /v1/webhooks and returns the config", async () => {
    const { http, calls } = fakeHttp(() => cfg({ secret: "whsec_full" }));
    const wh = await new Webhooks(http).set({ url: "https://app.example/hooks/xtrace" });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/v1/webhooks",
      body: { url: "https://app.example/hooks/xtrace" },
    });
    expect(calls[0]!.query).toBeUndefined(); // no rotate by default
    expect(wh.secret).toBe("whsec_full");
  });

  it("set passes rotate_secret=true when requested", async () => {
    const { http, calls } = fakeHttp(() => cfg());
    await new Webhooks(http).set({ url: "https://app.example/x" }, { rotateSecret: true });
    expect(calls[0]!.query).toEqual({ rotate_secret: "true" });
  });

  it("get / delete hit /v1/webhooks with the right verb", async () => {
    const { http, calls } = fakeHttp(() => cfg());
    const wh = new Webhooks(http);
    await wh.get();
    await wh.delete();
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(calls.every((c) => c.path === "/v1/webhooks")).toBe(true);
  });
});

// A signature produced by the same HMAC the server uses, so the verifier
// has a real fixture to check against.
async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test_0123456789";
  const body = JSON.stringify({ event: "memory.learning.completed", conv_id: "c1" });

  it("accepts a correct signature", async () => {
    const sig = await sign(secret, body);
    expect(await verifyWebhookSignature({ payload: body, signature: sig, secret })).toBe(true);
  });

  it("accepts raw bytes as the payload", async () => {
    const bytes = new TextEncoder().encode(body);
    const sig = await sign(secret, body);
    expect(await verifyWebhookSignature({ payload: bytes, signature: sig, secret })).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(secret, body);
    expect(
      await verifyWebhookSignature({ payload: body + " ", signature: sig, secret }),
    ).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const sig = await sign(secret, body);
    expect(
      await verifyWebhookSignature({ payload: body, signature: sig, secret: "whsec_wrong" }),
    ).toBe(false);
  });

  it("rejects a missing / malformed signature header", async () => {
    expect(await verifyWebhookSignature({ payload: body, signature: "", secret })).toBe(false);
    expect(await verifyWebhookSignature({ payload: body, signature: "garbage", secret })).toBe(false);
  });

  it("falls back to node:crypto when globalThis.crypto is absent (Node 18)", async () => {
    const sig = await sign(secret, body); // sign while the global is still present
    const original = globalThis.crypto;
    // Simulate stock Node 18.x, where the WebCrypto global is flag-gated.
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(await verifyWebhookSignature({ payload: body, signature: sig, secret })).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

describe("parseWebhookEvent", () => {
  const secret = "whsec_test_0123456789";

  it("returns the typed payload when the signature verifies", async () => {
    const body = JSON.stringify({
      event: "memory.learning.completed",
      job_id: "job_1",
      conv_id: "c1",
      user_id: "alice",
      memories: [{ id: "fact_1", type: "fact" }],
      memories_updated: [],
      timestamp: "2026-01-01T00:00:00Z",
    });
    const sig = await sign(secret, body);
    const event = await parseWebhookEvent({ payload: body, signature: sig, secret });
    expect(event.event).toBe("memory.learning.completed");
    if (event.event === "memory.learning.completed") {
      expect(event.memories[0]!.id).toBe("fact_1");
    }
  });

  it("throws when the signature does not verify", async () => {
    await expect(
      parseWebhookEvent({ payload: "{}", signature: "sha256=bad", secret }),
    ).rejects.toThrow(/verification failed/);
  });
});
