import { describe, it, expect } from "vitest";
import { Memories } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { Memory, SearchListEnvelope, SearchRequest } from "./types.js";

/** Minimal fact-shaped Memory for fixtures. */
function mem(id: string): Memory {
  return {
    id,
    object: "memory",
    type: "fact",
    text: `text-${id}`,
    user_id: null,
    agent_id: null,
    conv_id: null,
    app_id: null,
    group_ids: [],
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
 * Fake HttpClient that replays a scripted sequence of `SearchListEnvelope`s for
 * successive `POST /v1/memories/search` calls. Records each request body so a
 * test can assert how the cursor was threaded.
 */
function scriptedHttp(pages: SearchListEnvelope[]): {
  http: HttpClient;
  calls: SearchRequest[];
} {
  const calls: SearchRequest[] = [];
  let i = 0;
  const http = {
    request: async (_method: string, _path: string, options: { body?: SearchRequest } = {}) => {
      calls.push(options.body as SearchRequest);
      const body = pages[i++];
      if (!body) throw new Error("scriptedHttp: more search calls than scripted pages");
      return { body, status: 200, requestId: "req_test" };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

function page(ids: string[], has_more: boolean, next_cursor: string | null): SearchListEnvelope {
  return { object: "list", data: ids.map(mem), has_more, next_cursor };
}

describe("Memories.searchAll", () => {
  it("yields every row across multiple pages in order, then completes", async () => {
    const { http, calls } = scriptedHttp([
      page(["A", "B"], true, "cur1"),
      page(["C", "D"], true, "cur2"),
      page(["E"], false, null),
    ]);
    const body: SearchRequest = { query: "q", user_id: "alice" };

    const seen: string[] = [];
    for await (const m of new Memories(http).searchAll(body)) seen.push(m.id);

    expect(seen).toEqual(["A", "B", "C", "D", "E"]);
    // three pages requested; cursor threaded from each page's next_cursor
    expect(calls).toHaveLength(3);
    expect(calls[0]!.cursor).toBeUndefined();
    expect(calls[1]!.cursor).toBe("cur1");
    expect(calls[2]!.cursor).toBe("cur2");
  });

  it("stops after a single page when has_more is false", async () => {
    const { http, calls } = scriptedHttp([page(["A"], false, null)]);

    const seen: string[] = [];
    for await (const m of new Memories(http).searchAll({ query: "q" })) seen.push(m.id);

    expect(seen).toEqual(["A"]);
    expect(calls).toHaveLength(1);
  });

  it("stops when next_cursor is null even if has_more is true (defensive)", async () => {
    const { http, calls } = scriptedHttp([page(["A"], true, null)]);

    const seen: string[] = [];
    for await (const m of new Memories(http).searchAll({ query: "q" })) seen.push(m.id);

    expect(seen).toEqual(["A"]);
    expect(calls).toHaveLength(1);
  });

  it("does not mutate the caller's body object", async () => {
    const { http } = scriptedHttp([
      page(["A"], true, "cur1"),
      page(["B"], false, null),
    ]);
    const body: SearchRequest = { query: "q", user_id: "alice" };
    const snapshot = structuredClone(body);

    // drain the generator
    for await (const _m of new Memories(http).searchAll(body)) {
      void _m;
    }

    expect(body).toEqual(snapshot);
    expect("cursor" in body).toBe(false);
  });

  it("honors an explicit starting cursor on the first request", async () => {
    const { http, calls } = scriptedHttp([page(["A"], false, null)]);

    const seen: string[] = [];
    for await (const m of new Memories(http).searchAll({ query: "q", cursor: "start" })) seen.push(m.id);

    expect(seen).toEqual(["A"]);
    expect(calls[0]!.cursor).toBe("start");
  });
});
