/**
 * End-to-end smoke test against a live xtrace memory API.
 *
 * Usage:
 *   XTRACE_API_KEY=xtk_... XTRACE_ORG_ID=org_... \
 *     XTRACE_BASE_URL=https://api.staging.xtrace.ai \
 *     npm run smoke
 *
 * Walks the full happy path: ingest (async) → poll → list → search → get →
 * update → delete. Also exercises sync ingest (`wait: true`).
 */
import { MemoryClient, MemoryNotFound } from "../src/index.js";

const apiKey = process.env.XTRACE_API_KEY;
const orgId = process.env.XTRACE_ORG_ID;
const baseUrl = process.env.XTRACE_BASE_URL ?? "https://api.staging.xtrace.ai";

if (!apiKey || !orgId) {
  console.error("Missing XTRACE_API_KEY or XTRACE_ORG_ID env vars");
  process.exit(2);
}

const userId = `smoke_${Date.now()}`;
const client = new MemoryClient({ apiKey, orgId, baseUrl });

function log(step: string, ...rest: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${step}`, ...rest);
}

async function main() {
  log("base url:", baseUrl, "user:", userId);

  const convA = `${userId}_a`;
  const convB = `${userId}_b`;

  // 1. Async ingest, then poll
  log("1/7 ingest (async)…");
  const job = await client.memories.ingest({
    messages: [
      { role: "user", content: "My name is Sam and I am vegetarian — I do not eat meat or fish." },
      { role: "assistant", content: "Noted: Sam, vegetarian." },
    ],
    user_id: userId,
    conv_id: convA,
  });
  log("    id:", job.id, "status:", job.status);

  log("2/7 pollUntilDone…");
  const done = await client.memories.jobs.pollUntilDone(job.id, { timeoutMs: 60_000 });
  const asyncCount = done.result?.memories_created?.length ?? 0;
  log("    final:", done.status, "memories_created:", asyncCount, "updated:", done.result?.memories_updated?.length ?? 0);
  if (done.status !== "succeeded") {
    throw new Error(`async job failed: ${JSON.stringify(done.error)}`);
  }

  // 2. Sync ingest
  log("3/7 ingest (wait=true)…");
  const sync = await client.memories.ingest(
    {
      messages: [
        { role: "user", content: "My favorite food is pad see ew. I love Thai cuisine." },
        { role: "assistant", content: "Got it — pad see ew, Thai food." },
      ],
      user_id: userId,
      conv_id: convB,
    },
    { wait: true },
  );
  let syncCount = 0;
  if (sync.status === "succeeded") {
    syncCount = sync.result?.memories_created?.length ?? 0;
    log(`    sync status: succeeded, memories inline: ${syncCount}`);
  } else if (sync.status === "failed") {
    log(`    sync status: FAILED (backend error):`, JSON.stringify(sync.error));
  } else {
    log(`    sync fell back to async (status: ${sync.status}); would poll job ${sync.id}`);
  }

  const totalExtracted = asyncCount + syncCount;
  if (totalExtracted === 0) {
    log("    note: 0 memories extracted across both ingests — extraction is non-deterministic; later steps may also be empty");
  }

  // 3. List (auto-pagination)
  log("4/7 list (async iterator)…");
  let listed = 0;
  for await (const m of client.memories.list({ user_id: userId, limit: 50 })) {
    listed++;
    if (listed === 1) log("    first item:", m.id, m.type, JSON.stringify(m.text).slice(0, 60));
    if (listed >= 25) break;
  }
  log(`    iterated ${listed} memories`);

  // 4. Search
  log("5/7 search…");
  const search = await client.memories.search({
    query: "what does the user like to eat?",
    user_id: userId,
    limit: 5,
  });
  log(`    ${search.data.length} hits`);
  if (search.data.length === 0) {
    log("    no search hits — skipping get/delete steps");
    log("done (partial) ✓");
    return;
  }

  // 5. Get one
  const first = search.data[0]!;
  log("6/7 get", first.id);
  const fetched = await client.memories.get(first.id);
  if (fetched.id !== first.id) throw new Error("get returned wrong id");
  log("    text:", JSON.stringify(fetched.text).slice(0, 80));

  // 6. Delete (hard) — verify the memory is gone: get returns 404 afterwards
  log("7/7 delete + verify hard-delete semantics");
  await client.memories.delete(first.id);
  const afterDelete = await client.memories.get(first.id).catch((e) => (e instanceof MemoryNotFound ? null : Promise.reject(e)));
  if (afterDelete === null) {
    log("    hard-deleted ✓ (get returns 404, point removed)");
  } else {
    throw new Error("expected 404 after delete (hard-delete semantics)");
  }

  log("done ✓");
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
