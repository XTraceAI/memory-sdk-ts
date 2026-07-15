import { describe, it, expect } from "vitest";
import { withDirectiveRecall } from "./directives.js";
import type { MemoryClient } from "../client.js";
import type { DirectiveMemory, TriggerRequest } from "../types.js";

function lesson(id: string, text: string): DirectiveMemory {
  return {
    id,
    object: "memory",
    type: "lesson",
    text,
    user_id: "agent-7",
    agent_id: null,
    conv_id: null,
    app_id: null,
    group_ids: [],
    categories: ["lesson"],
    score: null,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
    details: {
      fact_type: "lesson",
      trigger_entities: ["stripe.refunds.create"],
      matched_on: ["stripe.refunds.create"],
      because: null,
      confidence: null,
      observation_count: null,
      last_confirmed_at: null,
      steps: null,
    },
  } as DirectiveMemory;
}

/** Fake client whose trigger returns a scripted queue of responses. */
function fakeClient(queue: DirectiveMemory[][], opts: { delayMs?: number } = {}) {
  const calls: TriggerRequest[] = [];
  const client = {
    memories: {
      trigger: async (body: TriggerRequest) => {
        calls.push(body);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const data = queue.length > 0 ? queue.shift()! : [];
        return { object: "list", data, has_more: false, next_cursor: null, context: null };
      },
    },
  } as unknown as MemoryClient;
  return { client, calls };
}

const runTool = (tools: Record<string, unknown>, name: string, args: unknown) =>
  (
    tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }
  ).execute(args, {});

describe("withDirectiveRecall", () => {
  it("recalls on the tool call and appends directives to a string result", async () => {
    const d = lesson("d1", "don't use stripe.refunds.create for annual invoices");
    const { client, calls } = fakeClient([[d]]);
    const tools = withDirectiveRecall(
      { refund: { execute: async () => "refund submitted" } },
      client,
      { agent_id: "billing", namespace: "acct:acme" },
    );

    const out = (await runTool(tools, "refund", { invoice_id: "INV-42" })) as string;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toEqual({ tool: "refund", args: { invoice_id: "INV-42" } });
    expect(calls[0]!.namespace).toBe("acct:acme");
    expect(calls[0]!.mode).toBe("retrieve");
    expect(out).toContain("refund submitted");
    expect(out).toContain("<team-directives>");
    expect(out).toContain("don't use stripe.refunds.create");
  });

  it("dedups client-side: a directive injects at most once per wrapper", async () => {
    const d = lesson("d1", "the lesson");
    const { client, calls } = fakeClient([[d], [d]]);
    const tools = withDirectiveRecall(
      { t: { execute: async () => "ok" } },
      client,
      { user_id: "u" },
    );

    const first = (await runTool(tools, "t", {})) as string;
    const second = (await runTool(tools, "t", {})) as string;

    expect(first).toContain("<team-directives>");
    // The HTTP TriggerRequest has no already_fired field (unlike the MCP
    // tool), so dedup lives entirely client-side: the fake returned d again
    // and the wrapper filtered it.
    expect(second).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("injects into plain-object results under xtrace_team_directives", async () => {
    const { client } = fakeClient([[lesson("d1", "the lesson")]]);
    const tools = withDirectiveRecall(
      { t: { execute: async () => ({ status: "ok" }) } },
      client,
      { user_id: "u" },
    );
    const out = (await runTool(tools, "t", {})) as Record<string, unknown>;
    expect(out.status).toBe("ok");
    expect(String(out.xtrace_team_directives)).toContain("the lesson");
  });

  it("leaves non-injectable result shapes untouched but notifies the observer", async () => {
    const seen: string[] = [];
    const { client } = fakeClient([[lesson("d1", "the lesson")]]);
    const tools = withDirectiveRecall(
      { t: { execute: async () => [1, 2, 3] } },
      client,
      { user_id: "u" },
      { onDirectives: (ds, name) => seen.push(`${name}:${ds[0]!.id}`) },
    );
    const out = await runTool(tools, "t", {});
    expect(out).toEqual([1, 2, 3]);
    expect(seen).toEqual(["t:d1"]);
  });

  it("fires a reactive recall with the output when a string result looks like a failure", async () => {
    const reactiveLesson = lesson("d2", "when FIN-409 rejects the refund, use credit notes");
    const { client, calls } = fakeClient([[], [reactiveLesson]]);
    const tools = withDirectiveRecall(
      { refund: { execute: async () => "Error: reconciliation rejected (FIN-409)" } },
      client,
      { user_id: "u" },
    );

    const out = (await runTool(tools, "refund", { invoice_id: "INV-9" })) as string;

    expect(calls).toHaveLength(2);
    expect(calls[1]!.action?.output).toContain("FIN-409");
    expect(out).toContain("use credit notes");
  });

  it("is fail-open: recall errors and timeouts never touch the result", async () => {
    const throwing = {
      memories: {
        trigger: async () => {
          throw new Error("server down");
        },
      },
    } as unknown as MemoryClient;
    const tools = withDirectiveRecall(
      { t: { execute: async () => "ok" } },
      throwing,
      { user_id: "u" },
    );
    expect(await runTool(tools, "t", {})).toBe("ok");

    const { client: slow } = fakeClient([[lesson("d1", "late")]], { delayMs: 200 });
    const tools2 = withDirectiveRecall(
      { t: { execute: async () => "ok" } },
      slow,
      { user_id: "u" },
      { timeoutMs: 10 },
    );
    expect(await runTool(tools2, "t", {})).toBe("ok");
  });

  it("passes through tools without an execute untouched", () => {
    const providerTool = { description: "provider-executed" };
    const tools = withDirectiveRecall(
      { p: providerTool },
      fakeClient([]).client,
      { user_id: "u" },
    );
    expect(tools.p).toBe(providerTool);
  });
});
