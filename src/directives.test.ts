import { describe, it, expect, vi } from "vitest";
import { Memories, renderDirectivesPrompt } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { DirectiveMemory } from "./types.js";
import { withDirectiveRecall } from "./ai-sdk/directives.js";

function dir(
  id: string,
  type: "lesson" | "procedure",
  text: string,
  entities: string[],
  because: string | null = null,
): DirectiveMemory {
  return {
    id,
    object: "memory",
    type,
    text,
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
      fact_type: type,
      trigger_entities: entities,
      matched_on: entities.slice(0, 1),
      because,
      confidence: because ? 0.8 : null,
      observation_count: 1,
      last_confirmed_at: null,
    },
  };
}

function fakeHttp(rows: DirectiveMemory[], context: string | null = null) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const http = {
    request: async (_m: string, path: string, opts: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: opts.body ?? {} });
      return { body: { object: "list", data: rows, context }, status: 200, requestId: "req_test" };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("recallDirectives", () => {
  it("builds the directive-corpus body, retrieve by default", async () => {
    const { http, calls } = fakeHttp([dir("l1", "lesson", "finalize on abort", ["tool_loop.py"])]);
    const m = new Memories(http);
    const res = await m.recallDirectives({
      user_id: "u",
      action: { tool: "Edit", args: { file_path: "tool_loop.py" } },
    });
    expect(res.data).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/memories/search");
    expect(calls[0]!.body.include).toEqual(["lesson", "procedure"]);
    expect(calls[0]!.body.mode).toBe("retrieve");
    expect(calls[0]!.body.action).toEqual({ tool: "Edit", args: { file_path: "tool_loop.py" } });
    expect(calls[0]!.body.user_id).toBe("u");
  });

  it("throws when neither action nor entities is given (firing rule)", async () => {
    const { http } = fakeHttp([]);
    const m = new Memories(http);
    await expect(
      m.recallDirectives({ user_id: "u" } as Parameters<Memories["recallDirectives"]>[0]),
    ).rejects.toThrow(/touching|action|entities/i);
  });

  it("throws on a fieldless action", async () => {
    const { http } = fakeHttp([]);
    const m = new Memories(http);
    await expect(m.recallDirectives({ user_id: "u", action: {} })).rejects.toThrow();
  });

  it("accepts explicit entities + compose mode + task, surfaces context", async () => {
    const { http, calls } = fakeHttp([dir("l1", "lesson", "x", ["a.py"], "why")], "## ctx");
    const m = new Memories(http);
    const res = await m.recallDirectives({
      user_id: "u",
      entities: ["a.py"],
      mode: "compose",
      task: "fix a.py",
    });
    expect(calls[0]!.body.mode).toBe("compose");
    expect(calls[0]!.body.entities).toEqual(["a.py"]);
    expect(calls[0]!.body.task).toBe("fix a.py");
    expect(res.context).toBe("## ctx");
  });
});

describe("renderDirectivesPrompt", () => {
  it("renders type-tagged bullets with because; empty → ''", () => {
    const md = renderDirectivesPrompt([dir("l1", "lesson", "do X", ["a.py"], "it helps")]);
    expect(md).toContain("[LESSON]");
    expect(md).toContain("do X");
    expect(md).toContain("it helps");
    expect(renderDirectivesPrompt([])).toBe("");
  });
});

describe("withDirectiveRecall (ai-sdk pre-tool hook)", () => {
  it("recalls before exec and prepends directives to a string result", async () => {
    const recallDirectives = vi.fn(async (_params: Record<string, unknown>) => ({
      data: [dir("l1", "lesson", "finalize on abort", ["tool_loop.py"])],
      context: null as string | null,
    }));
    const client = { memories: { recallDirectives } } as unknown as Parameters<
      typeof withDirectiveRecall
    >[1]["client"];
    const tools = { Edit: { execute: async () => "edited" } };
    const wrapped = withDirectiveRecall(tools, { client, user_id: "u" });
    const result = await (wrapped.Edit as { execute: (a: unknown, c: unknown) => Promise<string> })
      .execute({ file_path: "tool_loop.py" }, {});
    expect(recallDirectives).toHaveBeenCalledOnce();
    expect(recallDirectives.mock.calls[0]![0]).toMatchObject({
      action: { tool: "Edit", args: { file_path: "tool_loop.py" } },
    });
    expect(result).toContain("finalize on abort");
    expect(result).toContain("edited");
  });

  it("passes through tools without execute and fails soft on recall error", async () => {
    const recallDirectives = vi.fn(async () => {
      throw new Error("down");
    });
    const client = { memories: { recallDirectives } } as unknown as Parameters<
      typeof withDirectiveRecall
    >[1]["client"];
    const tools = { noExec: { description: "x" }, Edit: { execute: async () => "ok" } };
    const wrapped = withDirectiveRecall(tools, { client, user_id: "u" });
    expect(wrapped.noExec).toBe(tools.noExec);
    const result = await (wrapped.Edit as { execute: (a: unknown, c: unknown) => Promise<string> })
      .execute({}, {});
    expect(result).toBe("ok");
  });
});
