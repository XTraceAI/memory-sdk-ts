import { describe, it, expect } from "vitest";
import { f } from "./filter.js";
import type { Clause, FieldOps } from "./filter.js";
import { Memories } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { Filter, Memory, SearchRequest } from "./types.js";

describe("filter DSL — single-operator shorthands emit the documented wire JSON", () => {
  it("eq → { field: { $eq: v } }", () => {
    expect(f.eq("agent_id", "bot")).toEqual({ agent_id: { $eq: "bot" } });
  });

  it("ne → { field: { $ne: v } }", () => {
    expect(f.ne("status", "archived")).toEqual({ status: { $ne: "archived" } });
  });

  it("in → { field: { $in: [...] } }", () => {
    expect(f.in("agent_id", ["bot-a", "bot-b"])).toEqual({ agent_id: { $in: ["bot-a", "bot-b"] } });
  });

  it("nin → { field: { $nin: [...] } }", () => {
    expect(f.nin("plan", ["free", "trial"])).toEqual({ plan: { $nin: ["free", "trial"] } });
  });

  it("exists defaults to true, and takes an explicit false", () => {
    expect(f.exists("conv_id")).toEqual({ conv_id: { $exists: true } });
    expect(f.exists("conv_id", false)).toEqual({ conv_id: { $exists: false } });
  });

  it("between → { field: { $between: [lo, hi] } }", () => {
    expect(f.between("score", 0.5, 0.9)).toEqual({ score: { $between: [0.5, 0.9] } });
  });

  it("isNull → { field: null } (null = unset, per spec)", () => {
    expect(f.isNull("agent_id")).toEqual({ agent_id: null });
  });

  it("each range comparator is expressible via f.field", () => {
    expect(f.field("score", { $gt: 1 })).toEqual({ score: { $gt: 1 } });
    expect(f.field("score", { $gte: 1 })).toEqual({ score: { $gte: 1 } });
    expect(f.field("score", { $lt: 5 })).toEqual({ score: { $lt: 5 } });
    expect(f.field("score", { $lte: 5 })).toEqual({ score: { $lte: 5 } });
  });
});

describe("filter DSL — f.field is the only multi-operator-per-field path", () => {
  it("keeps BOTH operators for a two-sided range (no silent clobber)", () => {
    // The B1 fix: a range must not collapse to one operator.
    expect(f.field("price", { $gt: 10, $lt: 100 })).toEqual({ price: { $gt: 10, $lt: 100 } });
  });

  it("copies the ops object so a later caller mutation can't corrupt the clause", () => {
    const ops: FieldOps = { $gte: 0.5, $lt: 0.9 };
    const clause = f.field("score", ops);
    ops.$lt = 999; // mutate the caller's input after building
    expect(clause).toEqual({ score: { $gte: 0.5, $lt: 0.9 } });
  });

  it("deep-copies array-valued operators so caller array mutation can't corrupt the clause", () => {
    // A shallow {...ops} would leave $between/$in/$nin aliased to the caller's
    // arrays — mutating them afterwards would corrupt the already-built clause.
    const between: [number, number] = [10, 100];
    const inVals = ["a", "b"];
    const ops: FieldOps = { $between: between, $in: inVals };
    const clause = f.field("price", ops);
    between[1] = 999; // mutate the caller's tuple
    inVals.push("c"); // mutate the caller's array
    expect(clause).toEqual({ price: { $between: [10, 100], $in: ["a", "b"] } });
  });
});

describe("filter DSL — combinators emit AND/OR/NOT wire keys", () => {
  it("and → { AND: [...] }", () => {
    expect(f.and(f.eq("a", 1), f.eq("b", 2))).toEqual({
      AND: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    });
  });

  it("or → { OR: [...] }", () => {
    expect(f.or(f.eq("a", 1), f.eq("b", 2))).toEqual({
      OR: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    });
  });

  it("not → { NOT: <clause> }", () => {
    expect(f.not(f.eq("a", 1))).toEqual({ NOT: { a: { $eq: 1 } } });
  });

  it("f.and lets you AND two operators on the SAME field explicitly", () => {
    expect(f.and(f.field("price", { $gt: 10 }), f.field("price", { $lt: 100 }))).toEqual({
      AND: [{ price: { $gt: 10 } }, { price: { $lt: 100 } }],
    });
  });
});

describe("filter DSL — f.all implicit-ANDs distinct fields and throws on collision", () => {
  it("merges distinct-field clauses into one implicit-AND object", () => {
    expect(f.all(f.eq("agent_id", "bot"), f.in("plan", ["a", "b"]))).toEqual({
      agent_id: { $eq: "bot" },
      plan: { $in: ["a", "b"] },
    });
  });

  it("throws on a duplicate field, naming the field and the remedy", () => {
    expect(() => f.all(f.eq("x", 1), f.eq("x", 2))).toThrow(/duplicate field "x"/);
    // the message points the caller at f.field / f.and
    expect(() => f.all(f.eq("x", 1), f.eq("x", 2))).toThrow(/f\.field|f\.and/);
  });

  it("does not mutate its input clauses", () => {
    const a = f.eq("agent_id", "bot");
    const b = f.in("plan", ["a", "b"]);
    f.all(a, b);
    expect(a).toEqual({ agent_id: { $eq: "bot" } });
    expect(b).toEqual({ plan: { $in: ["a", "b"] } });
  });
});

describe("filter DSL — key-agnostic (A5 reconciliation)", () => {
  it("filters an arbitrary metadata/payload key identically to an entity axis", () => {
    // Entity axis and a customer metadata key build the same wire shape — the
    // builder has no fixed field enum, so dropping the typed `metadata` field
    // does not block metadata-key filtering.
    const entity = f.eq("agent_id", "bot");
    const meta = f.eq("tier", "gold");
    expect(entity).toEqual({ agent_id: { $eq: "bot" } });
    expect(meta).toEqual({ tier: { $eq: "gold" } });
    // mixed in one f.all, distinct keys coexist
    expect(f.all(entity, meta)).toEqual({
      agent_id: { $eq: "bot" },
      tier: { $eq: "gold" },
    });
  });
});

describe("filter DSL — output assignable to SearchRequest.filters", () => {
  it("a built Clause / Filter is assignable to the escape-hatch Filter type", () => {
    const clause: Clause = f.field("score", { $gte: 0.5 });
    const filter: Filter = clause; // Clause assignable to Record<string, unknown>
    const req: SearchRequest = { query: "q", filters: filter };
    expect(req.filters).toEqual({ score: { $gte: 0.5 } });
  });

  it("the raw Record escape hatch is still accepted directly", () => {
    const raw: Filter = { agent_id: { $eq: "bot" } };
    const req: SearchRequest = { query: "q", filters: raw };
    expect(req.filters).toEqual({ agent_id: { $eq: "bot" } });
  });
});

/** Minimal fact-shaped Memory; `over` patches any field. */
function mem(id: string, over: Partial<Memory> = {}): Memory {
  return {
    id,
    object: "memory",
    type: "fact",
    text: id,
    user_id: null,
    agent_id: null,
    conv_id: null,
    app_id: null,
    group_ids: [],
    categories: [],
    score: 1,
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

function fakeHttp(): { http: HttpClient; calls: SearchRequest[] } {
  const calls: SearchRequest[] = [];
  const http = {
    request: async (_method: string, path: string, options: { body?: SearchRequest } = {}) => {
      if (path === "/v1/groups") {
        return { body: { object: "list", data: [] }, status: 200, requestId: "req_test" };
      }
      calls.push(options.body as SearchRequest);
      return {
        body: { object: "list", data: [mem("A")], has_more: false, next_cursor: null },
        status: 200,
        requestId: "req_test",
      };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("filter DSL — capstone: round-trips through search() (mocked)", () => {
  it("builds a mixed eq/range/in filter, keeps both range ops, and search() forwards it verbatim", async () => {
    const filter = f.all(
      f.eq("agent_id", "bot"),
      f.field("score", { $gte: 0.5, $lt: 0.9 }),
      f.in("plan", ["a", "b"]),
    );

    // 1. exact documented wire shape, with BOTH range operators present
    expect(filter).toEqual({
      agent_id: { $eq: "bot" },
      score: { $gte: 0.5, $lt: 0.9 },
      plan: { $in: ["a", "b"] },
    });

    // 2. a same-field f.all is a loud throw, not a silent drop
    expect(() => f.all(f.eq("x", 1), f.eq("x", 2))).toThrow();

    // 3. assignable to SearchRequest.filters and forwarded unchanged by search()
    const { http, calls } = fakeHttp();
    const env = await new Memories(http).search({ query: "q", filters: filter });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filters).toEqual({
      agent_id: { $eq: "bot" },
      score: { $gte: 0.5, $lt: 0.9 },
      plan: { $in: ["a", "b"] },
    });
    expect(env.data.map((m) => m.id)).toEqual(["A"]);
  });
});
