import { describe, it, expect } from "vitest";
import { Memories, renderMemoriesPrompt } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { Memory, SearchRequest } from "./types.js";

/** Minimal fact-shaped Memory for fixtures; `over` patches any field. */
function mem(id: string, text: string, score: number | null, over: Partial<Memory> = {}): Memory {
  return {
    id,
    object: "memory",
    type: "fact",
    text,
    user_id: null,
    agent_id: null,
    conv_id: null,
    app_id: null,
    group_ids: [],
    categories: [],
    score,
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
    ...over,
  } as Memory;
}

/** Fake HttpClient that routes search bodies through `handler`. */
function fakeHttp(handler: (body: SearchRequest) => Memory[]): {
  http: HttpClient;
  calls: SearchRequest[];
} {
  const calls: SearchRequest[] = [];
  const http = {
    request: async (_method: string, _path: string, options: { body?: SearchRequest } = {}) => {
      const body = options.body as SearchRequest;
      calls.push(body);
      return {
        body: { object: "list", data: handler(body), has_more: false, next_cursor: null },
        status: 200,
        requestId: "req_test",
      };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("Memories.recall", () => {
  it("fans out one compose search per scope and dedupes by id (keeping higher score)", async () => {
    const { http, calls } = fakeHttp((body) =>
      body.user_id && !body.group_ids
        ? [mem("A", "personal-a", 0.9), mem("B", "b", 0.5)]
        : [mem("B", "b", 0.7), mem("C", "shared-c", 0.8)],
    );
    const res = await new Memories(http).recall({
      query: "q",
      user_id: "alice",
      group_ids: ["grp_x"],
    });

    // one personal call + one shared call, both default mode=compose
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.user_id === "alice" && !c.group_ids)).toBe(true);
    expect(calls.some((c) => c.group_ids?.[0] === "grp_x" && !c.user_id)).toBe(true);
    expect(calls.every((c) => c.mode === "compose")).toBe(true);

    // B is deduped to the higher-scored (0.7) copy; final order is score-desc
    expect(res.memories.map((m) => m.id)).toEqual(["A", "C", "B"]);
    expect(res.memories.find((m) => m.id === "B")!.score).toBe(0.7);

    expect(res.scopes).toEqual([
      { scope: "personal", count: 2 },
      { scope: "shared", count: 2 },
    ]);
    expect(res.prompt).toContain("- personal-a");
  });

  it("throws when neither user_id nor group_ids is supplied", async () => {
    const { http } = fakeHttp(() => []);
    await expect(new Memories(http).recall({ query: "q" })).rejects.toThrow(/at least one/);
  });

  it("only searches the personal scope when no group_ids", async () => {
    const { http, calls } = fakeHttp(() => [mem("A", "a", 0.5)]);
    await new Memories(http).recall({ query: "q", user_id: "alice" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user_id).toBe("alice");
  });

  it("caps the merged result to `limit`", async () => {
    const { http } = fakeHttp((body) =>
      body.user_id ? [mem("A", "a", 0.9), mem("B", "b", 0.8), mem("C", "c", 0.7)] : [],
    );
    const res = await new Memories(http).recall({ query: "q", user_id: "alice", limit: 2 });
    expect(res.memories.map((m) => m.id)).toEqual(["A", "B"]);
  });

  it("passes agent_id/app_id/mode through and honors a custom renderer", async () => {
    const { http, calls } = fakeHttp(() => [mem("A", "a", 0.5)]);
    const res = await new Memories(http).recall(
      { query: "q", user_id: "alice", agent_id: "bot", app_id: "app1", mode: "retrieve" },
      { render: (ms) => ms.map((m) => m.text).join("|") },
    );
    expect(calls[0]!.agent_id).toBe("bot");
    expect(calls[0]!.app_id).toBe("app1");
    expect(calls[0]!.mode).toBe("retrieve");
    expect(res.prompt).toBe("a");
  });
});

describe("renderMemoriesPrompt", () => {
  it("renders a flat bulleted block when all memories are one kind", () => {
    expect(
      renderMemoriesPrompt([mem("A", "likes thai", 0.9), mem("B", "allergic to peanuts", 0.8)]),
    ).toBe(
      "Relevant memories about the user:\n" +
        "- likes thai (recorded 2026-01-01)\n" +
        "- allergic to peanuts (recorded 2026-01-01)",
    );
  });

  it("splits personal vs shared (group-tagged) into sections, with categories", () => {
    const out = renderMemoriesPrompt([
      mem("P", "is vegetarian", 0.9, { categories: ["diet"] }),
      mem("S", "trip hotel is near Shibuya", 0.8, { group_ids: ["grp_tokyo"], categories: ["travel"] }),
    ]);
    expect(out).toBe(
      "Relevant memories about the user:\n\n" +
        "Personal:\n- is vegetarian [diet] (recorded 2026-01-01)\n\n" +
        "Shared (group):\n- trip hotel is near Shibuya [travel] (recorded 2026-01-01)",
    );
  });

  it("returns an empty string for no memories", () => {
    expect(renderMemoriesPrompt([])).toBe("");
  });
});
