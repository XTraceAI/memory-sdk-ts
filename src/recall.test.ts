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
      pools: [{ user_id: "alice" }, { group_ids: ["grp_x"] }],
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
      pools: [{ user_id: "alice" }, { group_ids: ["grp_tokyo"] }],
    });
    expect(res.prompt).toContain("Personal:");
    expect(res.prompt).toContain("Tokyo trip 2026:");
    expect(res.prompt).toContain("- stays near Shibuya [travel]");
    // the opaque id must not leak into the prompt once resolved to a name
    expect(res.prompt).not.toContain("grp_tokyo");
  });

  it("throws when pools is empty", async () => {
    const { http } = fakeHttp({});
    await expect(new Memories(http).recall({ query: "q", pools: [] })).rejects.toThrow(/pools/);
  });

  it("a single pool runs just one search", async () => {
    const { http, calls } = fakeHttp({ onSearch: () => [mem("A", "a", 0.5)] });
    await new Memories(http).recall({ query: "q", pools: [{ user_id: "alice" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user_id).toBe("alice");
  });

  it("caps the merged result to `limit`", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.user_id ? [mem("A", "a", 0.9), mem("B", "b", 0.8), mem("C", "c", 0.7)] : [],
    });
    const res = await new Memories(http).recall({ query: "q", pools: [{ user_id: "alice" }], limit: 2 });
    expect(res.memories.map((m) => m.id)).toEqual(["A", "B"]);
  });

  it("fair-merges so a row-rich personal scope can't starve the shared scope", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.user_id && !body.group_ids
          ? [mem("P1", "p1", 0.99), mem("P2", "p2", 0.98), mem("P3", "p3", 0.97)]
          : [mem("S1", "s1", 0.5, { group_ids: ["grp_x"] })],
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice" }, { group_ids: ["grp_x"] }],
      limit: 2,
    });
    const ids = res.memories.map((m) => m.id);
    // Plain top-2-by-score would be [P1, P2] and drop S1; round-robin keeps S1.
    expect(ids).toContain("S1");
    expect(ids).toHaveLength(2);
  });

  it("limit 1 returns the single most-relevant row across scopes (not always personal)", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.user_id && !body.group_ids
          ? [mem("P", "p", 0.4)] // personal, lower score
          : [mem("S", "s", 0.95, { group_ids: ["grp_x"] })], // shared, higher score
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice" }, { group_ids: ["grp_x"] }],
      limit: 1,
    });
    expect(res.memories.map((m) => m.id)).toEqual(["S"]); // higher-scoring shared wins the lone slot
  });

  it("group recall drops the caller's other-group memories from the personal scope", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.user_id && !body.group_ids
          ? [
              mem("U", "untagged pref", 0.9),
              mem("A", "alice trip-a note", 0.85, { group_ids: ["grp_a"], user_id: "alice" }),
              mem("B", "alice trip-b note", 0.8, { group_ids: ["grp_b"], user_id: "alice" }),
            ]
          : [], // shared scope empty for this case
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice" }, { group_ids: ["grp_a"] }],
      limit: 10,
    });
    const ids = res.memories.map((m) => m.id);
    expect(ids).toContain("U"); // untagged general pref kept
    expect(ids).toContain("A"); // requested-group fact kept
    expect(ids).not.toContain("B"); // other-group fact excluded — no cross-trip bleed
  });

  it("passes agent_id/app_id/mode through and honors a custom renderer", async () => {
    const { http, calls } = fakeHttp({ onSearch: () => [mem("A", "a", 0.5)] });
    const res = await new Memories(http).recall(
      { query: "q", pools: [{ user_id: "alice", agent_id: "bot", app_id: "app1" }], mode: "retrieve" },
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

  it("leaves single-user personal lines plain when no viewer is given", () => {
    // Standalone render of one user's own memories: rows carry user_id (real API
    // rows always do) but no viewerUserId is passed. Lines stay plain — the
    // author prefix is only for multi-user/group context, not normal personal use.
    expect(
      renderMemoriesPrompt([
        mem("A", "likes thai", 0.9, { user_id: "alice" }),
        mem("B", "allergic to peanuts", 0.8, { user_id: "alice" }),
      ]),
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
      { groupNames: { grp_tokyo: "Tokyo trip 2026" } },
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

  it("attributes shared (group) lines to their author; 'you' for the viewer", () => {
    const out = renderMemoriesPrompt(
      [
        mem("S1", "stays near Shibuya", 0.9, { group_ids: ["grp_tokyo"], user_id: "alice", categories: ["travel"] }),
        mem("S2", "loves Afuri ramen", 0.8, { group_ids: ["grp_tokyo"], user_id: "bob" }),
      ],
      { groupNames: { grp_tokyo: "Tokyo trip 2026" }, viewerUserId: "alice" },
    );
    expect(out).toBe(
      "Relevant memories about the user:\n\n" +
        "Tokyo trip 2026:\n" +
        "- you: stays near Shibuya [travel] (recorded 2026-01-01)\n" +
        "- bob: loves Afuri ramen (recorded 2026-01-01)",
    );
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

  it("honors a custom template (header + per-type labels + toggles)", () => {
    const out = renderMemoriesPrompt(
      [
        mem("F", "is vegetarian", 0.9, { categories: ["diet"] }),
        mem("D", "5-day plan", 0.8, {
          type: "artifact",
          details: { title: "Itinerary", rationale: null, version: null, root_id: null, source_fact_ids: [], episode_ids: [] },
        }),
      ],
      {
        template: {
          header: "Known about the user:",
          personalLabel: "Personal",
          unknownGroupLabel: "Group {id}",
          typeLabels: { fact: "", artifact: "[doc] ", episode: "[chat] " },
          includeCategories: false,
          includeRecordedDate: false,
          includeGroupAuthor: false,
        },
      },
    );
    // custom header, custom artifact tag, categories + date suppressed
    expect(out).toBe("Known about the user:\n- is vegetarian\n- [doc] Itinerary: 5-day plan");
  });

  it("buckets only requested groups; an other-group row falls under Personal", () => {
    const out = renderMemoriesPrompt(
      [
        mem("A1", "stays near Shibuya", 0.9, { group_ids: ["grp_a"], user_id: "alice" }),
        mem("B1", "likes the Louvre", 0.8, { group_ids: ["grp_b"], user_id: "alice" }),
      ],
      { groupNames: { grp_a: "Trip A", grp_b: "Trip B" }, requestedGroupIds: ["grp_a"], viewerUserId: "alice" },
    );
    expect(out).toContain("Trip A:");
    expect(out).toContain("Personal:");
    expect(out).toContain("- likes the Louvre"); // grp_b row, rendered as personal (unattributed)
    expect(out).not.toContain("Trip B"); // no leaked section / name
  });

  it("a row tagged to requested + extra groups shows only under the requested section", () => {
    const out = renderMemoriesPrompt(
      [mem("M", "shared fact", 0.9, { group_ids: ["grp_a", "grp_b"], user_id: "bob" })],
      { groupNames: { grp_a: "Trip A", grp_b: "Trip B" }, requestedGroupIds: ["grp_a"] },
    );
    expect(out).toContain("Trip A:");
    expect(out).not.toContain("Trip B");
  });

  it("returns an empty string for no memories", () => {
    expect(renderMemoriesPrompt([])).toBe("");
  });
});

describe("Memories.recall — pools (general union)", () => {
  const grp = (id: string, name: string) => ({
    object: "group" as const,
    id,
    name,
    prompt: "",
    status: "active" as const,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
  });

  it("unions explicit pools — personal + a global app_id KB", async () => {
    const { http, calls } = fakeHttp({
      onSearch: (body) =>
        body.app_id === "product-kb"
          ? [mem("K", "reset your key in settings", 0.95, { app_id: "product-kb" })]
          : [mem("P", "alice prefers dark mode", 0.7, { user_id: "alice" })],
    });
    const res = await new Memories(http).recall({
      query: "how do I reset my key?",
      pools: [{ user_id: "alice" }, { app_id: "product-kb" }],
    });
    // one search per pool, each scoped to just its own axis
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.user_id === "alice" && !c.app_id && !c.group_ids)).toBe(true);
    expect(calls.some((c) => c.app_id === "product-kb" && !c.user_id && !c.group_ids)).toBe(true);
    // both pools' rows unioned; no group pool → no group sections
    expect(res.memories.map((m) => m.id).sort()).toEqual(["K", "P"]);
    expect(res.scopes.map((s) => s.scope).sort()).toEqual(["personal", "scope"]);
    // the app KB row is sectioned under its source label — NOT mixed into the
    // user's personal facts, so a doc isn't framed as something the user said.
    expect(res.prompt).toContain("Personal:");
    expect(res.prompt).toContain("product-kb:");
    expect(res.prompt.indexOf("reset your key")).toBeGreaterThan(res.prompt.indexOf("product-kb:"));
    expect(res.prompt.indexOf("dark mode")).toBeLessThan(res.prompt.indexOf("product-kb:"));
  });

  it("rejects a malformed pool alongside a valid one (no silent drop)", async () => {
    const { http, calls } = fakeHttp({ onSearch: () => [] });
    // An empty group array carries no scope — dropping it would silently return
    // results missing the requested group. Must throw, naming the bad index.
    await expect(
      new Memories(http).recall({ query: "q", pools: [{ user_id: "alice" }, { group_ids: [] }] }),
    ).rejects.toThrow(/index 1|scope axis|at least one/);
    expect(calls).toHaveLength(0); // threw before issuing any search
  });

  it("strips an empty group_ids axis instead of forwarding a vacuous filter", async () => {
    const { http, calls } = fakeHttp({
      onSearch: () => [mem("P", "alice note", 0.9, { user_id: "alice" })],
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice", group_ids: [] }],
    });
    // The empty group_ids is dropped — the search goes out as a plain personal
    // scope, NOT `user_id AND (any-of [])` which would match nothing server-side.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user_id).toBe("alice");
    expect(calls[0]!.group_ids).toBeUndefined();
    expect(res.memories.map((m) => m.id)).toEqual(["P"]);
  });

  it("throws when no pool carries a scope axis", async () => {
    const { http } = fakeHttp({});
    await expect(new Memories(http).recall({ query: "q", pools: [{}] })).rejects.toThrow(
      /pools|at least one/,
    );
  });

  it("a non-group pool doesn't bleed in other groups when a group pool is present", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.group_ids
          ? [mem("G", "shibuya hotel", 0.8, { group_ids: ["grp_tokyo"], user_id: "bob" })]
          : [
              mem("UA", "alice tokyo note", 0.9, { group_ids: ["grp_tokyo"], user_id: "alice" }),
              mem("UB", "alice paris note", 0.85, { group_ids: ["grp_paris"], user_id: "alice" }),
            ],
      groups: [grp("grp_tokyo", "Tokyo trip")],
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice" }, { group_ids: ["grp_tokyo"] }],
    });
    const ids = res.memories.map((m) => m.id);
    expect(ids).toContain("UA"); // alice's tokyo row kept
    expect(ids).toContain("G"); // group pool's row kept
    expect(ids).not.toContain("UB"); // alice's paris row dropped — no cross-group bleed
    expect(res.prompt).toContain("Tokyo trip:");
  });

  it("keeps a non-user pool's rows even if they carry an unrelated group tag", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.group_ids
          ? [mem("T", "trip fact", 0.7, { group_ids: ["grp_trip"] })]
          : [mem("K", "kb doc", 0.9, { app_id: "kb", group_ids: ["grp_docs"] })],
      groups: [grp("grp_trip", "Trip")],
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ app_id: "kb" }, { group_ids: ["grp_trip"] }],
    });
    const ids = res.memories.map((m) => m.id);
    // The bleed filter is user-pool-only: the app pool's row stays even though it
    // carries grp_docs (not the requested grp_trip).
    expect(ids).toContain("K");
    expect(ids).toContain("T");
    // K renders under its own source section ("kb:"), T under its group ("Trip:")
    expect(res.prompt).toContain("Trip:");
    expect(res.prompt).toContain("kb:");
  });

  it("doesn't bleed-filter a deliberately-scoped user pool (user_id + app_id)", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.group_ids
          ? [mem("T", "trip fact", 0.6, { group_ids: ["grp_trip"] })]
          : [
              mem("D", "alice docs note", 0.9, {
                user_id: "alice",
                app_id: "docs",
                group_ids: ["grp_other"],
              }),
            ],
      groups: [grp("grp_trip", "Trip")],
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice", app_id: "docs" }, { group_ids: ["grp_trip"] }],
    });
    const ids = res.memories.map((m) => m.id);
    // The {user_id, app_id} pool is a deliberate scope — its rows are returned as
    // the axes select, even tagged to a non-requested group. Only a PLAIN
    // {user_id} pool is bleed-filtered (see the group-recall test above).
    expect(ids).toContain("D");
    expect(ids).toContain("T");
  });

  it("attributes a second user pool's rows (not presented as the viewer's)", async () => {
    const { http } = fakeHttp({
      onSearch: (body) =>
        body.user_id === "bob"
          ? [mem("B", "bob likes ramen", 0.8, { user_id: "bob" })]
          : [mem("A", "alice likes thai", 0.9, { user_id: "alice" })],
    });
    const res = await new Memories(http).recall({
      query: "q",
      pools: [{ user_id: "alice" }, { user_id: "bob" }],
    });
    // viewer = first user pool (alice): her line unattributed, bob's attributed.
    expect(res.prompt).toContain("- alice likes thai");
    expect(res.prompt).toContain("- bob: bob likes ramen");
    expect(res.prompt).not.toContain("you:"); // no group sections here
  });
});
