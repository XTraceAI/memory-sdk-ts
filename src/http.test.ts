import { describe, it, expect } from "vitest";
import { HttpClient, defaultHttpConfig } from "./http.js";
import { MemoryClient } from "./client.js";

/**
 * Capture the outgoing request headers from a single `request()` call. The
 * fetch impl records the `headers` object it was handed and returns a trivial
 * 200 so `request()` resolves without retrying.
 */
function captureHeaders(): {
  fetch: typeof globalThis.fetch;
  last: () => Record<string, string>;
} {
  let captured: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = (init.headers ?? {}) as Record<string, string>;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, last: () => captured };
}

describe("HttpClient auth header form", () => {
  it("defaults to Authorization: Bearer and sends no x-api-key", async () => {
    const cap = captureHeaders();
    const http = new HttpClient(
      defaultHttpConfig({ apiKey: "xtk_123", orgId: "org_9", fetch: cap.fetch }),
    );
    await http.request("GET", "/v1/thing");
    const h = cap.last();
    expect(h["Authorization"]).toBe("Bearer xtk_123");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["X-Org-Id"]).toBe("org_9");
  });

  it("authMode 'bearer' is byte-identical to the default", async () => {
    const cap = captureHeaders();
    const http = new HttpClient(
      defaultHttpConfig({ apiKey: "xtk_123", orgId: "org_9", fetch: cap.fetch, authMode: "bearer" }),
    );
    await http.request("GET", "/v1/thing");
    const h = cap.last();
    expect(h["Authorization"]).toBe("Bearer xtk_123");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["X-Org-Id"]).toBe("org_9");
  });

  it("authMode 'x-api-key' sends x-api-key and no Authorization", async () => {
    const cap = captureHeaders();
    const http = new HttpClient(
      defaultHttpConfig({ apiKey: "xtk_123", orgId: "org_9", fetch: cap.fetch, authMode: "x-api-key" }),
    );
    await http.request("GET", "/v1/thing");
    const h = cap.last();
    expect(h["x-api-key"]).toBe("xtk_123");
    expect(h["Authorization"]).toBeUndefined();
    expect(h["X-Org-Id"]).toBe("org_9");
  });
});

describe("MemoryClient auth header form (end-to-end plumbing)", () => {
  it("default client sends Authorization: Bearer and X-Org-Id, no x-api-key", async () => {
    const cap = captureHeaders();
    const client = new MemoryClient({ apiKey: "xtk_abc", orgId: "org_1", fetch: cap.fetch });
    await client.groups.list();
    const h = cap.last();
    expect(h["Authorization"]).toBe("Bearer xtk_abc");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["X-Org-Id"]).toBe("org_1");
  });

  it("authMode 'x-api-key' client sends x-api-key and X-Org-Id, no Authorization", async () => {
    const cap = captureHeaders();
    const client = new MemoryClient({
      apiKey: "xtk_abc",
      orgId: "org_1",
      fetch: cap.fetch,
      authMode: "x-api-key",
    });
    await client.groups.list();
    const h = cap.last();
    expect(h["x-api-key"]).toBe("xtk_abc");
    expect(h["Authorization"]).toBeUndefined();
    expect(h["X-Org-Id"]).toBe("org_1");
  });
});
