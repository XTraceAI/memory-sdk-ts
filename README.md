<div align="center">

<img src="assets/xtrace_orbital.gif" width="600" alt="xtrace memory">

<p><strong> Long-term memory for AI agents.<br>Send conversation messages, get back structured facts you can search. </strong></p>

<p>
  <a href="https://www.npmjs.com/package/@xtraceai/memory"><img src="https://img.shields.io/npm/v/@xtraceai/memory?color=blue&label=npm&cacheSeconds=0" alt="npm"></a>
  <a href="https://github.com/XTraceAI/memory-sdk-ts/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-ffffff?labelColor=d4eaf7&color=2e6cc4" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-18+-339933?logo=node.js&logoColor=white" alt="Node 18+"></a>
  <a href="https://docs.xtrace.ai"><img src="https://img.shields.io/badge/Docs-docs.xtrace.ai-blue" alt="Docs"></a>
</p>

<h4>
  <a href="https://docs.xtrace.ai">Documentation</a> |
  <a href="https://x.com/XTrace_ai">X</a> |
  <a href="https://www.linkedin.com/company/xtrace-ai/">LinkedIn</a>
</h4>
<sub>Encrypted vector search &rarr; <a href="https://github.com/XTraceAI/xtrace-sdk">xtrace-sdk</a></sub>
</div>

---

# What is xtrace memory?

`@xtraceai/memory` is the TypeScript SDK for the [xtrace memory API](https://api.production.xtrace.ai) — a hosted memory service for AI agents. Send raw conversation messages and the service extracts structured **facts**, **artifacts**, and **episodes** in the background. Search them later with vector + filter queries to give your agent durable, long-term memory.

- **Ingest** — drop in conversation messages; extraction runs async (or sync for short turns). Tag memories to shared **groups** for cross-user recall.
- **Search** — semantic vector search scoped by `user_id` / `group_ids` / `agent_id` / `app_id` (AND-everything). `recall()` merges a user's own memories with a shared group's in one call.
- **Manage** — list, get, and (hard) delete memories. Register tagging targets with the **groups** API.
- **Vercel AI SDK** — a drop-in `@xtraceai/memory/ai-sdk` subpath for auto-context and tool-based recall.

Works in Node 18+ (native `fetch`) and in the browser.

# Quick Start

> [!TIP]
> 🚀 **Create a free account at [app.xtrace.ai](https://app.xtrace.ai)** to get your API key and org ID. The free tier is rate-limited but fully functional.

## Install

```bash
npm install @xtraceai/memory
```

Requires Node 18+ (uses native `fetch`). Works in the browser too.

## Get credentials

Sign in at [app.xtrace.ai](https://app.xtrace.ai) and grab two values from **Settings → API Keys**:

- **API key** — `xtk_…`
- **Org id** — your organization identifier

Both are required on every request. See the [full docs](https://docs.xtrace.ai/guides/authentication) for storage best practices.

### Auth header form

By default the client sends the API key as `Authorization: Bearer <apiKey>`. If
your deployment authenticates with an `x-api-key` header instead, opt in with
`authMode`:

```ts
const client = new MemoryClient({
  apiKey: process.env.XTRACE_API_KEY!,
  orgId:  process.env.XTRACE_ORG_ID!,
  authMode: "x-api-key", // sends `x-api-key: <apiKey>`; omits `Authorization`
});
```

`X-Org-Id` is sent in both modes. `authMode` defaults to `"bearer"`, so existing
code is unaffected.

> [!NOTE]
> The scheme is a wire-format choice only — it carries **no rate-limit
> advantage**. Both `bearer` and `x-api-key` are throttled against the same
> `(org_id, key_hash)` rate bucket, so switching does not buy you extra quota.
> `bearer` is the default; pick `x-api-key` only if your deployment requires it.

## TypeScript SDK

```ts
import { MemoryClient } from "@xtraceai/memory";

const client = new MemoryClient({
  apiKey: process.env.XTRACE_API_KEY!, // xtk_...
  orgId: process.env.XTRACE_ORG_ID!,   // org_...
});

// Ingest — async by default. `conv_id` is currently required.
const job = await client.memories.ingest({
  messages: [{ role: "user", content: "I keep a daily log of every dog I see." }],
  user_id: "alice",
  conv_id: "conv_2026_05_15",
});

// Wait for extraction to finish
const done = await client.memories.jobs.pollUntilDone(job.id);
console.log(done.result?.memories_created);

// Or ingest synchronously (server waits up to 30s; falls back to async otherwise)
const sync = await client.memories.ingest(
  {
    messages: [{ role: "user", content: "I love Thai food." }],
    user_id: "alice",
    conv_id: "conv_2026_05_15",
  },
  { wait: true },
);
if (sync.status === "succeeded") {
  console.log(sync.result?.memories_created);
}

// When an ingest supersedes an existing fact, the result maps old id → new id
// (`result.memories_superseded_by`). Resolve a superseded fact to its
// replacement Memory without reading that map yourself:
const oldId = "mem_old"; // an id you held before this ingest
const replacement = await client.memories.resolveSuperseded(done.result!, oldId);
// → the new Memory, or null if `oldId` wasn't superseded in this ingest.

// Or resolve everything this ingest superseded in one call (Map<oldId, Memory>):
const replacements = await client.memories.resolveAllSuperseded(done.result!);

// Search — scope by what you pass (user_id / group_ids / agent_id / app_id all AND-narrow)
const results = await client.memories.search({
  query: "what does the user like to eat?",
  user_id: "alice",
});

// Personal + shared (group) recall in one call — unions the pools you pass
const { prompt } = await client.memories.recall({
  query: "what should we plan for dinner?",
  pools: [{ user_id: "alice" }, { group_ids: ["grp_tokyo2026"] }],
});

// Recall + heavy artifact bodies in one round-trip — `include` is forwarded to
// every pool, so `details.full_content` is populated on the rows it returns.
const { memories } = await client.memories.recall({
  query: "the trip itinerary",
  pools: [{ user_id: "alice" }, { group_ids: ["grp_tokyo2026"] }],
  include: ["full_content"],
});

// List with auto-pagination
for await (const memory of client.memories.list({ user_id: "alice" })) {
  console.log(memory.text);
}

// Search with auto-pagination — the search twin of list(); threads the cursor
// for you across pages until the server says has_more: false
for await (const memory of client.memories.searchAll({ query: "what does the user like to eat?", user_id: "alice" })) {
  console.log(memory.text);
}

// Get one
const memory = await client.memories.get(results.data[0]!.id);

// Edit group membership — the only in-place mutation on a memory.
// Pass add_group_ids and/or remove_group_ids; at least one is required.
// Resolves to the full updated Memory (group_ids reflects the edit).
const reTagged = await client.memories.patch(memory.id, {
  add_group_ids: ["grp_tokyo2026"],
  remove_group_ids: ["grp_archive"],
});
console.log(reTagged.group_ids);

// Delete (hard — the point is removed; get/list/search no longer return it, a second delete 404s)
await client.memories.delete(memory.id);
```

The patch body is typed as `MemoryPatchRequest`. An empty patch (`{}`, or both
arrays empty) throws synchronously — the server would reject it with
`422 empty_patch`, so the SDK saves the round-trip:

```ts
import type { MemoryPatchRequest } from "@xtraceai/memory";

const changes: MemoryPatchRequest = { add_group_ids: ["grp_tokyo2026"] };
await client.memories.patch("mem_123", changes);
```

## Filtering

Scope axes (`user_id` / `agent_id` / `app_id` / `group_ids`) are top-level
fields on `search`. For anything richer — ranges, set membership, negation,
existence, or filtering on your own indexed payload keys — pass a filter to
`search({ filters })`. Use the typed `f` builder instead of hand-writing the
wire JSON: it's discoverable, and it makes a silently-wrong query impossible.

```ts
import { f } from "@xtraceai/memory";

// (agent_id == "bot") AND (0.5 <= score < 0.9) AND (plan in ["a", "b"])
const results = await client.memories.search({
  query: "recent activity",
  filters: f.all(
    f.eq("agent_id", "bot"),
    f.field("score", { $gte: 0.5, $lt: 0.9 }), // a range keeps BOTH operators
    f.in("plan", ["a", "b"]),
  ),
});
```

`f.field(name, ops)` is the only way to put multiple operators on one field, so
a two-sided range can't silently collapse to one bound. `f.all(...)` merges
clauses on **distinct** fields and **throws** on a duplicate field — combine a
field's operators in a single `f.field` call, or `f.and(...)` to AND two
conditions on the same field explicitly.

```ts
// single-operator shorthands
f.eq("status", "active");          // { status: { $eq: "active" } }
f.ne("status", "archived");        // { status: { $ne: "archived" } }
f.in("plan", ["pro", "team"]);     // { plan: { $in: ["pro", "team"] } }
f.nin("plan", ["free"]);           // { plan: { $nin: ["free"] } }
f.exists("conv_id");               // { conv_id: { $exists: true } }
f.exists("conv_id", false);        // { conv_id: { $exists: false } }
f.between("score", 0.5, 0.9);      // { score: { $between: [0.5, 0.9] } }
f.isNull("agent_id");              // { agent_id: null }  ← null = unset

// boolean composition
f.and(f.eq("a", 1), f.eq("b", 2)); // { AND: [...] }
f.or(f.eq("a", 1), f.eq("b", 2));  // { OR:  [...] }
f.not(f.eq("a", 1));               // { NOT: { a: { $eq: 1 } } }
```

The builder is **key-agnostic** — it filters any indexed payload key, including
your own metadata keys, exactly the way it filters an entity axis:

```ts
// `tier` is a customer metadata key; it filters identically to a built-in axis.
filters: f.all(f.eq("agent_id", "bot"), f.eq("tier", "gold"));
```

The builder's output is a plain object assignable to `SearchRequest.filters`, so
the raw `Filter` (`Record<string, unknown>`) escape hatch still works if you'd
rather hand-write the JSON. (Lifting scope axes such as `user_id` *out of*
`filters` is deprecated — set those as top-level fields — but the operator DSL
over payload keys is fully supported.)

## Vercel AI SDK integration

A separate subpath, `@xtraceai/memory/ai-sdk`, ships two ways to use the SDK with the [Vercel AI SDK](https://ai-sdk.dev). Peer dependencies (`ai`, `zod`) are optional — they're only required if you import from this subpath.

### Memory-aware model wrapper (auto-context + auto-ingest)

Wraps any `LanguageModel` so it searches your memory before each call and ingests the turn after. Set it and forget it:

```ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createXtraceMemory } from "@xtraceai/memory/ai-sdk";

const xtrace = createXtraceMemory({
  apiKey: process.env.XTRACE_API_KEY!,
  orgId:  process.env.XTRACE_ORG_ID!,
  user_id: "alice",
  conv_id: "conv_42",
});

const result = streamText({
  model: xtrace(openai("gpt-4o-mini")),  // memory-aware wrapper
  messages,
});
```

### Memory as tools (LLM decides when to recall / save)

For agent loops where you want the model in control of memory access:

```ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { MemoryClient } from "@xtraceai/memory";
import { memoryTools } from "@xtraceai/memory/ai-sdk";

const client = new MemoryClient({ apiKey, orgId });

const result = streamText({
  model: openai("gpt-4o-mini"),
  tools: memoryTools(client, { user_id: "alice", conv_id: "conv_42" }),
  messages,
});
```

The model gets two tools: `search_memory(query, limit?)` and `save_memory(fact)`. Use `{ includeSave: false }` for read-only.

## Webhooks

Register one endpoint per org and XTrace POSTs a signed event when an ingest job finishes — `memory.learning.completed` (fires even when nothing was extracted, so you can unblock the user) or `memory.learning.failed` — instead of you polling `client.memories.jobs`.

```ts
// Register (or replace) the org's webhook. The full `secret` is returned only
// here — on first create or `{ rotateSecret: true }`. Store it.
const wh = await client.webhooks.set({ url: "https://your-app.com/hooks/xtrace" });
console.log(wh.secret); // whsec_… — save this

await client.webhooks.get();    // current config (secret masked)
await client.webhooks.delete(); // remove it (idempotent)
```

On your endpoint, verify the `X-Webhook-Signature` over the **raw body** before trusting the event. `verifyWebhookSignature` / `parseWebhookEvent` use Web Crypto, so they run in Node 18+, browsers, and edge runtimes:

```ts
import express from "express";
import { parseWebhookEvent, type WebhookEventPayload } from "@xtraceai/memory";

const app = express();

// Capture the RAW body — re-serializing a parsed object breaks the signature.
app.post("/hooks/xtrace", express.raw({ type: "application/json" }), async (req, res) => {
  let event: WebhookEventPayload;
  try {
    event = await parseWebhookEvent({
      payload: req.body, // Buffer / raw bytes
      signature: req.header("X-Webhook-Signature") ?? "",
      secret: process.env.XTRACE_WEBHOOK_SECRET!,
    });
  } catch {
    return res.status(401).end(); // signature didn't verify
  }

  if (event.event === "memory.learning.completed") {
    // event.conv_id / event.user_id correlate back to your ingest call
    console.log("ready:", event.conv_id, event.memories.map((m) => m.id));
  }
  res.status(200).end(); // ack with any 2xx
});
```

Delivery is best-effort with a few retries — an event may be **dropped or duplicated**, so make your handler idempotent (dedupe on `job_id`), and use `client.memories.jobs.pollUntilDone(jobId)` as the fallback for anything you can't miss. See the [Webhooks guide](https://docs.xtrace.ai/guides/webhooks) for the full contract.

## Error handling

All errors extend `MemoryError`. Match on `error.code` for stable machine-readable handling:

```ts
import { MemoryNotFound, RateLimited } from "@xtraceai/memory";

try {
  await client.memories.get("fact_does_not_exist");
} catch (err) {
  if (err instanceof MemoryNotFound) {
    // ...
  } else if (err instanceof RateLimited) {
    // err.retryAfter is the seconds to wait
  }
}
```

`error.code` is populated regardless of which envelope the server emits — the
legacy `{ error: { code, message } }`, the spec `{ detail: { code, message } }`,
or FastAPI's plain `{ detail: "..." }` string (which sets `error.message`). A
`422` validation response (`{ detail: [...] }`) surfaces as `Unprocessable` with
`error.code === "validation_error"` and the raw per-field array under
`error.details.validation_errors`:

```ts
import { Unprocessable } from "@xtraceai/memory";

try {
  await client.memories.search({ query: "" });
} catch (err) {
  if (err instanceof Unprocessable) {
    const fields = err.details?.validation_errors; // raw FastAPI 422 array
  }
}
```

### Rate limits

When the server sends `x-ratelimit-limit` / `x-ratelimit-remaining` /
`x-ratelimit-reset` headers, the SDK parses them into a `RateLimitSnapshot`. On
any thrown error, read it from `err.rateLimit` so you can back off proactively:

```ts
import { RateLimited } from "@xtraceai/memory";

try {
  await client.memories.search({ query: "recent context" });
} catch (err) {
  if (err instanceof RateLimited && err.rateLimit?.remaining === 0) {
    // err.rateLimit.reset is an EPOCH-SECONDS timestamp, not a duration:
    //   const waitMs = (err.rateLimit.reset * 1000) - Date.now();
    // (err.retryAfter carries the server's Retry-After for a 429)
  }
}
```

> [!IMPORTANT]
> `reset` is an **epoch-seconds timestamp** (the wall-clock time the window
> rolls over) — **not** a number of seconds to wait. Compute the delay as
> `reset * 1000 - Date.now()`; do not pass `reset` straight to a `setTimeout`.

Absent headers leave every `RateLimitSnapshot` field `undefined`. Rate-limit
state is exposed per-response — there is no client-level "last seen" global,
because the SDK fans out concurrent requests and a shared snapshot would be
racy.

Note (v0.3.0): the snapshot is parsed for **every** response, but on the
**success** path it is currently only available on the internal
`HttpClient.request()` return — the public methods (`memories.*`, `groups.*`)
return just the parsed body, so there is no public success-path read yet. A
public success-path rate-limit surface is deferred until there is demand for
it; today, `err.rateLimit` on a thrown error is the supported way to observe
the bucket state.

## Documentation

Full documentation at [docs.xtrace.ai](https://docs.xtrace.ai).

### Type surface & generated reference (maintainers)

The hand-authored `src/types.ts` is the canonical public type surface
(see `docs/adr/ADR-002`). `src/generated/types.ts` is a spec-derived
**reference** — produced by `npm run gen:types`
(`openapi-typescript spec/memory.json`) and imported by nothing in `src/`.
Do not hand-edit the generated file; regenerate it from the spec instead.

`npm run check:types-sync` (`gen:types` + `git diff --exit-code` on the
generated file) proves the committed reference is exactly what the current
`spec/memory.json` produces, catching reference drift. It is chained into
`prepublishOnly`, so a publish fails if the generated reference is stale.
After any `spec/memory.json` change, run `npm run gen:types` and commit the
regenerated reference.

**openapi-typescript version pin:** the reference is generated with
**openapi-typescript `^7.4.0`** (the version installed at generation time was
`7.13.0`). The generator's output format can shift between minor versions, so a
bump can make `check:types-sync` fail even with no spec change. If that happens,
it is not spec drift — run `npm run gen:types`, review the diff, and commit the
regenerated reference. Keep the devDependency pin tight to avoid spurious
failures.

# License

MIT — see [LICENSE](LICENSE).
