import { describe, it, expect } from "vitest";
import { Memories } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { IngestJobResult, Memory } from "./types.js";

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

/** Build an IngestJobResult carrying only the superseded map (rest is filler). */
function result(superseded: Record<string, string>): IngestJobResult {
  return {
    memories_created: [],
    memories_updated: [],
    memories_superseded_by: superseded,
    stage_timings: {},
    ignored_group_ids: [],
  };
}

/**
 * Fake HttpClient that serves `GET /v1/memories/{id}` from a fixture map and
 * records every requested path so a test can assert which ids were fetched.
 * A 404 (unknown id) throws, mirroring the real client.
 */
function fakeHttp(byId: Record<string, Memory>): {
  http: HttpClient;
  paths: string[];
} {
  const paths: string[] = [];
  const http = {
    request: async (_method: string, path: string) => {
      paths.push(path);
      // path is /v1/memories/{encodedId}
      const id = decodeURIComponent(path.slice("/v1/memories/".length));
      const found = byId[id];
      if (!found) throw new Error(`404: ${id}`);
      return { body: found, status: 200, requestId: "req_test" };
    },
  } as unknown as HttpClient;
  return { http, paths };
}

describe("Memories.resolveSuperseded", () => {
  it("returns the replacement Memory when oldId is in the superseded map", async () => {
    const { http, paths } = fakeHttp({ new1: mem("new1") });
    const memories = new Memories(http);

    const replacement = await memories.resolveSuperseded(result({ old1: "new1" }), "old1");

    expect(replacement).not.toBeNull();
    expect(replacement!.id).toBe("new1");
    // followed the map: old1 → new1, fetched via get(new1)
    expect(paths).toEqual(["/v1/memories/new1"]);
  });

  it("returns null when oldId is not superseded (no fetch)", async () => {
    const { http, paths } = fakeHttp({ new1: mem("new1") });
    const memories = new Memories(http);

    const replacement = await memories.resolveSuperseded(result({ old1: "new1" }), "unknown");

    expect(replacement).toBeNull();
    // a non-superseded id never hits the network
    expect(paths).toEqual([]);
  });

  it("returns null when the superseded map is empty", async () => {
    const { http, paths } = fakeHttp({});
    const memories = new Memories(http);

    const replacement = await memories.resolveSuperseded(result({}), "old1");

    expect(replacement).toBeNull();
    expect(paths).toEqual([]);
  });

  it("url-encodes the replacement id in the get() path", async () => {
    const { http, paths } = fakeHttp({ "new id": mem("new id") });
    const memories = new Memories(http);

    const replacement = await memories.resolveSuperseded(result({ old1: "new id" }), "old1");

    expect(replacement!.id).toBe("new id");
    expect(paths).toEqual(["/v1/memories/new%20id"]);
  });
});

describe("Memories.resolveAllSuperseded", () => {
  it("resolves every superseded old id to its replacement Memory", async () => {
    const { http, paths } = fakeHttp({ newA: mem("newA"), newB: mem("newB") });
    const memories = new Memories(http);

    const map = await memories.resolveAllSuperseded(result({ oldA: "newA", oldB: "newB" }));

    expect(map.size).toBe(2);
    expect(map.get("oldA")!.id).toBe("newA");
    expect(map.get("oldB")!.id).toBe("newB");
    // one get() per superseded entry
    expect(paths.sort()).toEqual(["/v1/memories/newA", "/v1/memories/newB"]);
  });

  it("returns an empty map when nothing was superseded", async () => {
    const { http, paths } = fakeHttp({});
    const memories = new Memories(http);

    const map = await memories.resolveAllSuperseded(result({}));

    expect(map.size).toBe(0);
    expect(paths).toEqual([]);
  });
});
