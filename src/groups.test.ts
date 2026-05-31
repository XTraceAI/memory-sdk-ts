import { describe, it, expect } from "vitest";
import { Groups } from "./groups.js";
import type { HttpClient } from "./http.js";
import type { Group } from "./types.js";

function grp(id: string, over: Partial<Group> = {}): Group {
  return {
    object: "group",
    id,
    name: "Trip",
    prompt: "facts about the trip",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    ...over,
  };
}

function fakeHttp(handler: (method: string, path: string, body: unknown) => unknown): {
  http: HttpClient;
  calls: Array<{ method: string; path: string; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const http = {
    request: async (method: string, path: string, options: { body?: unknown } = {}) => {
      calls.push({ method, path, body: options.body });
      return { body: handler(method, path, options.body), status: 200, requestId: "req_test" };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("Groups", () => {
  it("create POSTs to /v1/groups and returns the group", async () => {
    const { http, calls } = fakeHttp(() => grp("grp_x", { name: "Tokyo", prompt: "p" }));
    const g = await new Groups(http).create({ name: "Tokyo", prompt: "p" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/groups",
      body: { name: "Tokyo", prompt: "p" },
    });
    expect(g.id).toBe("grp_x");
  });

  it("list unwraps the envelope to Group[]", async () => {
    const { http, calls } = fakeHttp(() => ({ object: "list", data: [grp("grp_a"), grp("grp_b")] }));
    const gs = await new Groups(http).list();
    expect(calls[0]!.method).toBe("GET");
    expect(gs.map((g) => g.id)).toEqual(["grp_a", "grp_b"]);
  });

  it("get / update / archive hit the id path with the right verb", async () => {
    const { http, calls } = fakeHttp(() => grp("grp_x", { status: "archived" }));
    const groups = new Groups(http);
    await groups.get("grp_x");
    await groups.update("grp_x", { prompt: "new" });
    const archived = await groups.archive("grp_x");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "DELETE"]);
    expect(calls.every((c) => c.path === "/v1/groups/grp_x")).toBe(true);
    expect(calls[1]!.body).toEqual({ prompt: "new" });
    expect(archived.status).toBe("archived");
  });

  it("url-encodes ids in the path", async () => {
    const { http, calls } = fakeHttp(() => grp("weird id"));
    await new Groups(http).get("weird id");
    expect(calls[0]!.path).toBe("/v1/groups/weird%20id");
  });
});
