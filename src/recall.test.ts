import { describe, it, expect } from "vitest";
import { Memories, renderMemoriesPrompt } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { Group, Memory, SearchRequest } from "./types.js";

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

/**
 * Fake HttpClient. `onSearch` produces rows for `POST /v1/memories/search`;
 * `groups` is returned for the `GET /v1/groups` name-resolution call. `calls`
 * records only the search bodies.
 */
function fakeHttp(opts: { onSearch?: (body: SearchRequest) => Memory[]; groups?: Group[] }): {
  http: HttpClient;
  calls: SearchRequest[];
} {
  const calls: SearchRequest[] = [];
  const http = {
    request: async (method: string, path: string, options: { body?: SearchRequest } = {}) => {
      if (method === "GET" && path === "/v1/groups") {
        return { body: { object: "list", data: opts.groups ?? [] }, status: 200, requestId: "req_test" };
      }
      const body = options.body as SearchRequest;
      calls.push(body);
      return {
        body: { object: "list", data: (opts.onSearch ?? (() => []))(body), has_more: false, next_cursor: null },
        status: 200,
        requestId: "req_test",
      };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("Memories.recall", () => {
  it("fans out one compose search per scope and dedupes by id (keeping higher score)", async () => {
    const { http, calls } = fakeHttp({
      onSearch: (body) =>
        body.user_id && !body.group_ids
          ? [mem("A", "personal-a", 0.9), mem("B", "b", 0.5)]
          : [mem("B", "b", 0.7), mem("C", "shared-c", 0.8)],
    });
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

  it("resolves group names from the registry and labels the shared section", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.group_ids
          ? [mem("S", "stays near Shibuya", 0.8, { group_ids: ["grp_tokyo"], categories: ["travel"] })]
          : [mem("P", "is vegetarian", 0.9, { categories: ["diet"] })],
      groups: [
        {
          object: "group",
          id: "grp_tokyo",
          name: "Tokyo trip 2026",
          prompt: "facts about the Tokyo trip",
          status: "active",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: null,
        },
      ],
    });
    const res = await new Memories(http).recall({
      query: "q",
      user_id: "alice",
      group_ids: ["grp_tokyo"],
    });
    expect(res.prompt).toContain("Personal:");
    expect(res.prompt).toContain("Tokyo trip 2026:");
    expect(res.prompt).toContain("- stays near Shibuya [travel]");
    // the opaque id must not leak into the prompt once resolved to a name
    expect(res.prompt).not.toContain("grp_tokyo");
  });

  it("throws when neither user_id nor group_ids is supplied", async () => {
    const { http } = fakeHttp({});
    await expect(new Memories(http).recall({ query: "q" })).rejects.toThrow(/at least one/);
  });

  it("only searches the personal scope when no group_ids", async () => {
    const { http, calls } = fakeHttp({ onSearch: () => [mem("A", "a", 0.5)] });
    await new Memories(http).recall({ query: "q", user_id: "alice" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user_id).toBe("alice");
  });

  it("caps the merged result to `limit`", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.user_id ? [mem("A", "a", 0.9), mem("B", "b", 0.8), mem("C", "c", 0.7)] : [],
    });
    const res = await new Memories(http).recall({ query: "q", user_id: "alice", limit: 2 });
    expect(res.memories.map((m) => m.id)).toEqual(["A", "B"]);
  });

  it("passes agent_id/app_id/mode through and honors a custom renderer", async () => {
    const { http, calls } = fakeHttp({ onSearch: () => [mem("A", "a", 0.5)] });
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

  it("splits personal vs per-group shared sections, labeled by group name", () => {
    const out = renderMemoriesPrompt(
      [
        mem("P", "is vegetarian", 0.9, { categories: ["diet"] }),
        mem("S", "trip hotel is near Shibuya", 0.8, { group_ids: ["grp_tokyo"], categories: ["travel"] }),
      ],
      { grp_tokyo: "Tokyo trip 2026" },
    );
    expect(out).toBe(
      "Relevant memories about the user:\n\n" +
        "Personal:\n- is vegetarian [diet] (recorded 2026-01-01)\n\n" +
        "Tokyo trip 2026:\n- trip hotel is near Shibuya [travel] (recorded 2026-01-01)",
    );
  });

  it("falls back to an id-based label when the group name is unknown", () => {
    const out = renderMemoriesPrompt([mem("S", "x", 0.8, { group_ids: ["grp_z"] })]);
    expect(out).toContain("Shared group grp_z:");
  });

  it("tags artifacts/episodes by type (with title); facts stay plain", () => {
    const out = renderMemoriesPrompt([
      mem("F", "is vegetarian", 0.9, { categories: ["diet"] }),
      mem("D", "5-day plan with hotels", 0.8, {
        type: "artifact",
        details: { title: "Tokyo itinerary", rationale: null, version: null, root_id: null, source_fact_ids: [], episode_ids: [] },
      }),
      mem("E", "discussed hotel options", 0.7, {
        type: "episode",
        details: { title: "Trip planning", started_at: null, ended_at: null, fact_ids: [], artifact_ids: [] },
      }),
    ]);
    expect(out).toContain("- is vegetarian [diet] (recorded 2026-01-01)");
    expect(out).toContain("- [document] Tokyo itinerary: 5-day plan with hotels (recorded 2026-01-01)");
    expect(out).toContain("- [conversation] Trip planning: discussed hotel options (recorded 2026-01-01)");
  });

  it("returns an empty string for no memories", () => {
    expect(renderMemoriesPrompt([])).toBe("");
  });
});
