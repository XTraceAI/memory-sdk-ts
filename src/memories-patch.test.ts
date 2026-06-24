import { describe, it, expect, vi } from "vitest";
import { Memories } from "./memories.js";
import { HttpClient } from "./http.js";
import type { Memory } from "./types.js";
import { Unprocessable } from "./errors.js";

/**
 * Build a real {@link HttpClient} whose `fetch` returns a single crafted
 * `Response`, so a call drives the *production* error path
 * (`http.toError → parseErrorBody → errorForStatus → Unprocessable`) rather
 * than a hand-built error. Mirrors the `clientReturning` helper in
 * `errors.test.ts`. `maxRetries: 0` so a 422 is not retried and the first
 * non-ok response throws immediately.
 */
function clientReturning(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): HttpClient {
  const fetchImpl = (async () => {
    const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
    return new Response(text, {
      status: opts.status,
      headers: { "content-type": "application/json", ...opts.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return new HttpClient({
    apiKey: "k",
    orgId: "o",
    baseUrl: "https://api.test.local",
    fetch: fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
  });
}

/** Minimal fact-shaped Memory for fixtures; override `group_ids` per case. */
function mem(id: string, group_ids: string[] = []): Memory {
  return {
    id,
    object: "memory",
    type: "fact",
    text: `text-${id}`,
    user_id: null,
    agent_id: null,
    conv_id: null,
    app_id: null,
    group_ids,
    categories: [],
    score: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    details: {
      fact_type: null,
      status: null,
      supersedes: null,
      source_role: null,
      episode_id: null,
      artifact_id: null,
      artifact_ids: [],
      source_event_ids: [],
    },
  } as Memory;
}

/**
 * Fake HttpClient capturing every (method, path, body, signal, requestId) and
 * returning a caller-supplied `Memory` as the response body. Mirrors the live
 * `PATCH /v1/memories/{id}` happy path captured in gitban card 2syddu
 * ("A4b HAPPY-PATH CAPTURED": 200 + full Memory, group_ids reflecting the edit).
 */
function fakeHttp(responder: () => Memory): {
  http: HttpClient;
  request: ReturnType<typeof vi.fn>;
  calls: Array<{
    method: string;
    path: string;
    body: unknown;
    signal: unknown;
    requestId: unknown;
  }>;
} {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    signal: unknown;
    requestId: unknown;
  }> = [];
  const request = vi.fn(
    async (
      method: string,
      path: string,
      options: { body?: unknown; signal?: unknown; requestId?: unknown } = {},
    ) => {
      calls.push({
        method,
        path,
        body: options.body,
        signal: options.signal,
        requestId: options.requestId,
      });
      return { body: responder(), status: 200, requestId: "req_test", rateLimit: undefined };
    },
  );
  const http = { request } as unknown as HttpClient;
  return { http, request, calls };
}

describe("memories.patch — group-membership editing (A4b, card 2syddu)", () => {
  it("add: PATCHes /v1/memories/{id} with only add_group_ids, resolves to the updated Memory", async () => {
    const { http, calls } = fakeHttp(() => mem("mem_1", ["grp_x"]));
    const memories = new Memories(http);

    const out = await memories.patch("mem_1", { add_group_ids: ["grp_x"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/v1/memories/mem_1",
      body: { add_group_ids: ["grp_x"] },
    });
    // no remove_group_ids key on the wire when its array is empty/absent
    expect(calls[0]!.body).not.toHaveProperty("remove_group_ids");
    expect(out.group_ids).toEqual(["grp_x"]);
  });

  it("remove: sends only remove_group_ids, resolves to a Memory with the membership gone", async () => {
    const { http, calls } = fakeHttp(() => mem("mem_1", []));
    const memories = new Memories(http);

    const out = await memories.patch("mem_1", { remove_group_ids: ["grp_x"] });

    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: "/v1/memories/mem_1",
      body: { remove_group_ids: ["grp_x"] },
    });
    expect(calls[0]!.body).not.toHaveProperty("add_group_ids");
    expect(out.group_ids).toEqual([]);
  });

  it("both: sends both arrays on the wire", async () => {
    const { http, calls } = fakeHttp(() => mem("mem_1", ["a"]));
    const memories = new Memories(http);

    await memories.patch("mem_1", { add_group_ids: ["a"], remove_group_ids: ["b"] });

    expect(calls[0]!.body).toEqual({ add_group_ids: ["a"], remove_group_ids: ["b"] });
  });

  it("url-encodes the id in the path", async () => {
    const { http, calls } = fakeHttp(() => mem("weird id", ["g"]));
    const memories = new Memories(http);

    await memories.patch("weird id", { add_group_ids: ["g"] });

    expect(calls[0]!.path).toBe("/v1/memories/weird%20id");
  });

  it("empty patch ({}) throws synchronously BEFORE any request() call", async () => {
    const { http, request } = fakeHttp(() => mem("mem_1"));
    const memories = new Memories(http);

    await expect(memories.patch("mem_1", {})).rejects.toThrow(
      /add_group_ids.*remove_group_ids.*empty_patch|empty_patch/i,
    );
    const msg = await memories.patch("mem_1", {}).catch((e: Error) => e.message);
    expect(msg).toContain("add_group_ids");
    expect(msg).toContain("remove_group_ids");
    expect(msg).toContain("empty_patch");
    expect(request).not.toHaveBeenCalled();
  });

  it("both arrays empty is treated as an empty patch and throws before request()", async () => {
    const { http, request } = fakeHttp(() => mem("mem_1"));
    const memories = new Memories(http);

    await expect(
      memories.patch("mem_1", { add_group_ids: [], remove_group_ids: [] }),
    ).rejects.toThrow(/empty_patch/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("threads context.requestId and context.signal into request()", async () => {
    const { http, calls } = fakeHttp(() => mem("mem_1", ["grp_x"]));
    const memories = new Memories(http);
    const controller = new AbortController();

    await memories.patch(
      "mem_1",
      { add_group_ids: ["grp_x"] },
      { requestId: "req_custom", signal: controller.signal },
    );

    expect(calls[0]!.requestId).toBe("req_custom");
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("defensive: a server 422 empty_patch surfaces as Unprocessable carrying code 'empty_patch'", async () => {
    // The client guard normally prevents this, but document the server contract
    // captured in card 2syddu: an empty patch the server sees → 422 empty_patch.
    const request = vi.fn(async () => {
      throw new Unprocessable({
        message: "Provide add_group_ids and/or remove_group_ids",
        status: 422,
        errorType: "invalid_request_error",
        code: "empty_patch",
      });
    });
    const http = { request } as unknown as HttpClient;
    const memories = new Memories(http);

    // Bypass the client guard with a populated array so the (mocked) server path runs.
    await expect(memories.patch("mem_1", { add_group_ids: ["grp_x"] })).rejects.toMatchObject({
      code: "empty_patch",
    });
  });

  // The defensive test above documents the contract by hand-building an
  // `Unprocessable`. The two below instead drive a *real* 422 wire body through
  // the production error path (`http.toError → parseErrorBody → errorForStatus`)
  // via a real HttpClient, proving the SDK's own parsing extracts
  // `code: "empty_patch"` from the live envelope — one assertion per wire shape
  // the parser supports (legacy `{error:{…}}` and spec `{detail:{…}}`).
  it("drives the live empty_patch 422 envelope through the production parser — legacy {error:{…}} shape", async () => {
    // The exact shape captured in card 2syddu's "A4b" section (legacy-first).
    const http = clientReturning({
      status: 422,
      body: {
        error: {
          type: "invalid_request_error",
          code: "empty_patch",
          message: "Provide add_group_ids and/or remove_group_ids",
        },
      },
    });
    const memories = new Memories(http);

    // Populated array bypasses the client guard so the wire/parse path runs.
    const err = await memories
      .patch("mem_1", { add_group_ids: ["grp_x"] })
      .then(() => {
        throw new Error("expected patch to reject");
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Unprocessable);
    expect(err).toMatchObject({
      status: 422,
      code: "empty_patch",
      errorType: "invalid_request_error",
    });
  });

  it("drives the live empty_patch 422 envelope through the production parser — spec {detail:{…}} shape", async () => {
    const http = clientReturning({
      status: 422,
      body: { detail: { code: "empty_patch", message: "Provide add_group_ids and/or remove_group_ids" } },
    });
    const memories = new Memories(http);

    const err = await memories
      .patch("mem_1", { remove_group_ids: ["grp_x"] })
      .then(() => {
        throw new Error("expected patch to reject");
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Unprocessable);
    expect(err).toMatchObject({ status: 422, code: "empty_patch" });
  });
});
