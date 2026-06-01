import { describe, it, expect } from "vitest";
import { memoryTools } from "./tools.js";
import type { MemoryClient } from "../client.js";

/** Fake client recording which memory method each tool calls + with what. */
function fakeClient() {
  const calls = { recall: [] as unknown[], search: [] as unknown[], ingest: [] as unknown[] };
  const client = {
    memories: {
      recall: async (p: unknown) => {
        calls.recall.push(p);
        return { memories: [], prompt: "", scopes: [] };
      },
      search: async (p: unknown) => {
        calls.search.push(p);
        return { object: "list", data: [], has_more: false, next_cursor: null };
      },
      ingest: async (b: unknown) => {
        calls.ingest.push(b);
        return { status: "succeeded", result: { memories_created: [] } };
      },
    },
  } as unknown as MemoryClient;
  return { client, calls };
}

// The ai-sdk Tool stores the execute fn; invoke it directly (2nd arg is the
// tool-call options, which our executors ignore).
const exec = (t: unknown, args: unknown) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {});

describe("memoryTools group scope", () => {
  it("array group_ids → search routes through recall, save forwards group_ids", async () => {
    const { client, calls } = fakeClient();
    const tools = memoryTools(client, { user_id: "alice", conv_id: "c", group_ids: ["grp_x"] });
    await exec(tools.search_memory, { query: "q" });
    await exec((tools as { save_memory: unknown }).save_memory, { fact: "f" });

    expect(calls.recall).toHaveLength(1);
    expect((calls.recall[0] as { pools?: unknown[] }).pools).toEqual([
      { user_id: "alice" },
      { group_ids: ["grp_x"] },
    ]);
    expect(calls.search).toHaveLength(0);
    expect(calls.ingest).toHaveLength(1);
    expect((calls.ingest[0] as { group_ids?: string[] }).group_ids).toEqual(["grp_x"]);
  });

  it("no group_ids → search is personal-only, save sends no group_ids", async () => {
    const { client, calls } = fakeClient();
    const tools = memoryTools(client, { user_id: "alice", conv_id: "c" });
    await exec(tools.search_memory, { query: "q" });
    await exec((tools as { save_memory: unknown }).save_memory, { fact: "f" });

    expect(calls.recall).toHaveLength(0);
    expect(calls.search).toHaveLength(1);
    expect((calls.ingest[0] as { group_ids?: string[] }).group_ids).toBeUndefined();
  });

  it("a non-array group_ids is treated as no-groups by BOTH tools (gates agree)", async () => {
    const { client, calls } = fakeClient();
    const tools = memoryTools(client, {
      user_id: "alice",
      conv_id: "c",
      group_ids: "grp_x" as unknown as string[], // runtime type violation a JS caller could make
    });
    await exec(tools.search_memory, { query: "q" });
    await exec((tools as { save_memory: unknown }).save_memory, { fact: "f" });

    expect(calls.recall).toHaveLength(0); // NOT the recall path
    expect(calls.search).toHaveLength(1); // personal-only
    expect((calls.ingest[0] as { group_ids?: string[] }).group_ids).toBeUndefined();
  });
});
