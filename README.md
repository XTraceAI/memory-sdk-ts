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

// List with auto-pagination
for await (const memory of client.memories.list({ user_id: "alice" })) {
  console.log(memory.text);
}

// Get one
const memory = await client.memories.get(results.data[0]!.id);

// Delete (hard — the point is removed; get/list/search no longer return it, a second delete 404s)
await client.memories.delete(memory.id);
```

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

## Documentation

Full documentation at [docs.xtrace.ai](https://docs.xtrace.ai).

# License

MIT — see [LICENSE](LICENSE).
