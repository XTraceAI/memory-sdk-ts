# @xtraceai/memory

TypeScript SDK for the [xtrace memory API](https://api.production.xtrace.ai) — a hosted memory service for AI agents. Send conversation messages, get back structured facts, artifacts, and episodes; search them with vector + filter queries.

## Install

```bash
npm install @xtraceai/memory
```

Requires Node 18+ (uses native `fetch`). Works in the browser too.

## Quickstart

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

// Search
const results = await client.memories.search({
  query: "what does the user like to eat?",
  filters: { user_id: "alice" },
});

// List with auto-pagination
for await (const memory of client.memories.list({ user_id: "alice" })) {
  console.log(memory.text);
}

// Get one
const memory = await client.memories.get(results.data[0]!.id);

// Update
await client.memories.update(memory.id, { text: "Updated content" });

// Delete (soft — sets details.status to "retracted"; hidden from list/search)
await client.memories.delete(memory.id);
```

## Errors

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

## License

MIT
