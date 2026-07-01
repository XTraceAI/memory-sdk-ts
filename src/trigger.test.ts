import { describe, it, expect } from "vitest";
import { Memories, renderLessonProcedurePrompt } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { LessonMemory, ProcedureMemory, TriggerRequest, TriggerResponse } from "./types.js";

/** Minimal lesson/procedure row for fixtures; `over` patches details. */
function insight(
  id: string,
  type: "lesson" | "procedure",
  text: string,
  details: Partial<LessonMemory["details"]> = {},
): LessonMemory | ProcedureMemory {
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
      trigger_entities: [],
      matched_on: [],
      because: null,
      confidence: null,
      observation_count: null,
      last_confirmed_at: null,
      ...details,
    },
  } as LessonMemory | ProcedureMemory;
}

/**
 * Fake HttpClient for the trigger endpoint. `onTrigger` builds the response from
 * the request body; `fail` (when set) makes every request reject. `calls`
 * records the trigger bodies. `signals` records the AbortSignal passed per call.
 */
function fakeHttp(opts: {
  onTrigger?: (body: TriggerRequest) => Partial<TriggerResponse>;
  fail?: () => never;
}): { http: HttpClient; calls: TriggerRequest[]; signals: (AbortSignal | undefined)[] } {
  const calls: TriggerRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const http = {
    request: async (
      _method: string,
      _path: string,
      options: { body?: TriggerRequest; signal?: AbortSignal } = {},
    ) => {
      const body = options.body as TriggerRequest;
      calls.push(body);
      signals.push(options.signal);
      if (opts.fail) opts.fail();
      const partial = (opts.onTrigger ?? (() => ({})))(body);
      const response: TriggerResponse = {
        object: "search",
        mode: body.mode ?? "compose",
        data: [],
        context: null,
        stage_timings: {},
        context_selection_applied: false,
        ...partial,
      };
      return { body: response, status: 200, requestId: "req_test" };
    },
  } as unknown as HttpClient;
  return { http, calls, signals };
}

describe("Memories.trigger", () => {
  it("posts action + scope and returns the matched rows", async () => {
    const { http, calls } = fakeHttp({
      onTrigger: () => ({ data: [insight("L1", "lesson", "use git -C")] }),
    });
    const res = await new Memories(http).trigger({
      action: { tool: "Edit", args: { file_path: "routes.py" } },
      user_id: "alice",
    });
    expect(calls[0]!.action?.tool).toBe("Edit");
    expect(calls[0]!.user_id).toBe("alice");
    expect(res.data.map((r) => r.id)).toEqual(["L1"]);
  });
});

describe("Memories.preToolHook", () => {
  it("defaults to compose and passes the server context through untouched", async () => {
    const { http, calls } = fakeHttp({
      onTrigger: () => ({
        data: [insight("L1", "lesson", "use git -C", { because: "shell state resets" })],
        context: "## Relevant directives\n- **[LESSON]** use git -C",
      }),
    });
    const res = await new Memories(http).preToolHook(
      { tool: "Bash", args: { command: "cd repo" } },
      { user_id: "alice", task: "run git" },
    );
    expect(calls[0]!.mode).toBe("compose");
    // Server context is forwarded verbatim (its wording is the backend's concern).
    expect(res.context).toBe("## Relevant directives\n- **[LESSON]** use git -C");
    expect(res.memories.map((m) => m.id)).toEqual(["L1"]);
    expect(res.degraded).toBe(false);
  });

  it("client-renders the block under retrieve (no server context)", async () => {
    const { http, calls } = fakeHttp({
      onTrigger: () => ({
        data: [
          insight("L1", "lesson", "use git -C", { because: "shell state resets" }),
          insight("P1", "procedure", "fetch then diff"),
        ],
      }),
    });
    const res = await new Memories(http).preToolHook(
      { entities: ["git", "VecDB-Backend"] },
      { user_id: "alice", mode: "retrieve" },
    );
    expect(calls[0]!.mode).toBe("retrieve");
    expect(calls[0]!.action).toBeUndefined();
    expect(calls[0]!.entities).toEqual(["git", "VecDB-Backend"]);
    expect(res.context).toBe(
      "Relevant lessons & procedures:\n" +
        "- **[LESSON]** use git -C — shell state resets\n" +
        "- **[PROCEDURE]** fetch then diff",
    );
  });

  it("fails soft to an empty, degraded result on a network error", async () => {
    const { http } = fakeHttp({
      fail: () => {
        throw new Error("ECONNRESET");
      },
    });
    const res = await new Memories(http).preToolHook(
      { tool: "Edit", args: {} },
      { user_id: "alice" },
    );
    expect(res).toEqual({ context: "", memories: [], degraded: true });
  });

  it("throws synchronously when no scope axis is given", async () => {
    const { http, calls } = fakeHttp({});
    await expect(
      new Memories(http).preToolHook({ tool: "Edit", args: {} }, {}),
    ).rejects.toThrow(/scope axis/);
    expect(calls).toHaveLength(0); // never hit the network
  });

  it("throws synchronously when there is no firing signal", async () => {
    const { http, calls } = fakeHttp({});
    await expect(
      new Memories(http).preToolHook({ entities: [] }, { user_id: "alice" }),
    ).rejects.toThrow(/action.*or.*entities/s);
    expect(calls).toHaveLength(0);
  });

  it("degrades (does not throw) when the caller's signal is already aborted", async () => {
    const { http } = fakeHttp({
      fail: () => {
        throw new Error("aborted");
      },
    });
    const res = await new Memories(http).preToolHook(
      { tool: "Edit", args: {} },
      { user_id: "alice", signal: AbortSignal.abort() },
    );
    expect(res.degraded).toBe(true);
  });
});

describe("renderLessonProcedurePrompt", () => {
  it("returns empty string for no rows", () => {
    expect(renderLessonProcedurePrompt([])).toBe("");
  });

  it("tags each row by type and appends the gate rationale when present", () => {
    const block = renderLessonProcedurePrompt([
      insight("L1", "lesson", "use git -C", { because: "shell state resets" }),
      insight("P1", "procedure", "fetch then diff"),
    ]);
    expect(block).toBe(
      "Relevant lessons & procedures:\n" +
        "- **[LESSON]** use git -C — shell state resets\n" +
        "- **[PROCEDURE]** fetch then diff",
    );
  });
});
