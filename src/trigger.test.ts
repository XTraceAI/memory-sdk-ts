import { describe, it, expect } from "vitest";
import { Memories } from "./memories.js";
import type { HttpClient } from "./http.js";
import type { DirectiveMemory, SearchListEnvelope, TriggerRequest } from "./types.js";

/** A lesson-shaped directive row, as `POST /v1/memories/trigger` returns it. */
function directive(id: string, over: Partial<DirectiveMemory> = {}): DirectiveMemory {
  return {
    id,
    object: "memory",
    type: "lesson",
    text:
      "When refunding an annual/net-60 invoice, don't use stripe.refunds.create — " +
      "finance rejects it with FIN-409; create a credit note instead.",
    user_id: "agent-7",
    agent_id: null,
    conv_id: null,
    app_id: null,
    group_ids: [],
    categories: ["lesson"],
    score: null,
    created_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
    details: {
      fact_type: "lesson",
      trigger_entities: ["stripe.refunds.create", "CN-ANNUAL", "FIN-409"],
      matched_on: ["stripe.refunds.create"],
      because: null,
      confidence: null,
      observation_count: null,
      last_confirmed_at: null,
      steps: null,
    },
    ...over,
  } as DirectiveMemory;
}

/** Fake HttpClient recording trigger bodies and returning a canned envelope. */
function fakeHttp(envelope: SearchListEnvelope): {
  http: HttpClient;
  calls: Array<{ method: string; path: string; body: TriggerRequest }>;
} {
  const calls: Array<{ method: string; path: string; body: TriggerRequest }> = [];
  const http = {
    request: async (method: string, path: string, opts: { body?: unknown } = {}) => {
      calls.push({ method, path, body: opts.body as TriggerRequest });
      return { body: envelope, response: new Response() };
    },
  } as unknown as HttpClient;
  return { http, calls };
}

describe("memories.trigger", () => {
  it("POSTs the body to /v1/memories/trigger verbatim and returns the envelope", async () => {
    const row = directive("d1");
    const envelope: SearchListEnvelope = {
      object: "list",
      data: [row],
      has_more: false,
      next_cursor: null,
      context: "## Relevant directives\n- **[LESSON]** don't use stripe.refunds.create…",
    };
    const { http, calls } = fakeHttp(envelope);
    const memories = new Memories(http);

    const body: TriggerRequest = {
      user_id: "agent-7",
      namespace: "acct:acme-corp",
      action: { tool: "stripe.refunds.create", args: { invoice_id: "INV-42" } },
      task: "process Acme's refund",
      mode: "compose",
    };
    const res = await memories.trigger(body);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/memories/trigger");
    // The wire body is passed through untouched — no client-side defaults
    // (unlike ingest's extract_artifacts), so server defaults stay in charge.
    expect(calls[0].body).toEqual(body);
    expect(res.context).toContain("Relevant directives");
    expect(res.data).toHaveLength(1);
  });

  it("narrows directive rows: matched_on and steps are typed", async () => {
    const proc = directive("d2", {
      type: "procedure",
      details: {
        fact_type: "procedure",
        trigger_entities: ["billing/credit_notes", "CN-ANNUAL"],
        matched_on: ["billing/credit_notes"],
        because: null,
        confidence: null,
        observation_count: 2,
        last_confirmed_at: null,
        steps: ["Create the credit note.", "Notify #ar-ops."],
      },
    });
    const { http } = fakeHttp({
      object: "list",
      data: [proc],
      has_more: false,
      next_cursor: null,
      context: null,
    });
    const res = await new Memories(http).trigger({
      user_id: "agent-7",
      entities: ["billing/credit_notes"],
      mode: "retrieve",
    });

    const row = res.data[0];
    expect(row.type).toBe("procedure");
    const d = row as DirectiveMemory;
    expect(d.details.matched_on).toEqual(["billing/credit_notes"]);
    expect(d.details.steps).toHaveLength(2);
  });
});
