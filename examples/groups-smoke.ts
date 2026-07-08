/**
 * Staging verification for the catch-all groups API change (prompt-less groups).
 *
 * Usage:
 *   XTRACE_API_KEY=xtk_... XTRACE_ORG_ID=org_... \
 *     XTRACE_BASE_URL=https://api.staging.xtrace.ai \
 *     npm run smoke:groups
 *
 * Walks every behavior the SDK types now encode:
 *   1. create with prompt (regression)         → prompt round-trips
 *   2. create without prompt                   → prompt: null (catch-all)
 *   3. create with prompt: ""                  → 422 (only omission means catch-all)
 *   4. get / list round-trip the null prompt
 *   5. PATCH a prompt onto a catch-all         → converts to prompted
 *   6. PATCH prompt: "" on a prompted group    → 422 (prompt can't be removed)
 *   7. ingest with a catch-all group id        → shareable memory tagged,
 *                                                 personal memory NOT tagged
 *   8. ingest with an archived catch-all id    → echoed in ignored_group_ids
 *   9. cleanup (archive groups, delete created memories)
 *
 * Step 7's tagging checks depend on the LLM classifier's shareable/personal
 * judgment, so those two assertions are reported but non-fatal; everything
 * else is a hard failure.
 */
import { MemoryClient, Unprocessable } from "../src/index.js";
import type { Memory } from "../src/index.js";

const apiKey = process.env.XTRACE_API_KEY;
const orgId = process.env.XTRACE_ORG_ID;
const baseUrl = process.env.XTRACE_BASE_URL ?? "https://api.staging.xtrace.ai";

if (!apiKey || !orgId) {
  console.error("Missing XTRACE_API_KEY or XTRACE_ORG_ID env vars");
  process.exit(2);
}

const runId = Date.now();
const userId = `grpsmoke_${runId}`;
const client = new MemoryClient({ apiKey, orgId, baseUrl });

function log(step: string, ...rest: unknown[]) {
  // eslint-disable-next-line no-console
  console.log(`[groups-smoke] ${step}`, ...rest);
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/** Expect the thunk to reject with a 422. */
async function expect422(label: string, thunk: () => Promise<unknown>) {
  try {
    await thunk();
  } catch (err) {
    assert(err instanceof Unprocessable, `${label}: expected 422, got ${err}`);
    log(`    ${label}: rejected with 422 ✓`);
    return;
  }
  throw new Error(`ASSERTION FAILED: ${label}: expected 422, request succeeded`);
}

/** Classifier-dependent checks are reported, not fatal. */
const softFailures: string[] = [];
function softAssert(cond: boolean, msg: string) {
  if (cond) log(`    ${msg} ✓`);
  else {
    softFailures.push(msg);
    log(`    ⚠ SOFT FAIL (classifier judgment): ${msg}`);
  }
}

async function main() {
  log("base url:", baseUrl, "user:", userId);
  const createdGroupIds: string[] = [];
  const createdMemoryIds: string[] = [];

  try {
    // 1. Prompted create still works (regression)
    log("1/9 create with prompt…");
    const prompted = await client.groups.create({
      name: `grpsmoke prompted ${runId}`,
      prompt: "Facts about the fictional Lisbon offsite in September 2026.",
    });
    createdGroupIds.push(prompted.id);
    assert(typeof prompted.prompt === "string" && prompted.prompt.length > 0, "prompted group round-trips its prompt");
    log("    id:", prompted.id, "prompt:", JSON.stringify(prompted.prompt));

    // 2. Prompt-less create → catch-all
    log("2/9 create WITHOUT prompt (catch-all)…");
    const catchAll = await client.groups.create({ name: `grpsmoke catch-all ${runId}` });
    createdGroupIds.push(catchAll.id);
    assert(catchAll.prompt === null, `catch-all group has prompt === null (got ${JSON.stringify(catchAll.prompt)})`);
    log("    id:", catchAll.id, "prompt:", catchAll.prompt);

    // 3. Empty-string prompt is rejected — only omission means catch-all
    log("3/9 create with prompt: \"\" …");
    await expect422("create with empty prompt", () =>
      client.groups.create({ name: `grpsmoke empty ${runId}`, prompt: "" }),
    );

    // 4. Null prompt round-trips through get + list
    log("4/9 get/list round-trip…");
    const fetched = await client.groups.get(catchAll.id);
    assert(fetched.prompt === null, "get() returns prompt: null for the catch-all");
    const listed = (await client.groups.list()).find((g) => g.id === catchAll.id);
    assert(listed !== undefined && listed.prompt === null, "list() returns prompt: null for the catch-all");
    log("    get + list both report prompt: null ✓");

    // 5. Setting a prompt converts a catch-all to a prompted group
    log("5/9 PATCH prompt onto a fresh catch-all…");
    const convertee = await client.groups.create({ name: `grpsmoke convertee ${runId}` });
    createdGroupIds.push(convertee.id);
    const converted = await client.groups.update(convertee.id, { prompt: "Facts about tabletop games." });
    assert(converted.prompt === "Facts about tabletop games.", "PATCH converts catch-all → prompted");
    log("    converted, prompt:", JSON.stringify(converted.prompt));

    // 6. A prompt can never be removed via PATCH
    log("6/9 PATCH prompt: \"\" on a prompted group…");
    await expect422("PATCH with empty prompt", () =>
      client.groups.update(prompted.id, { prompt: "" }),
    );
    const stillPrompted = await client.groups.get(prompted.id);
    assert(typeof stillPrompted.prompt === "string", "prompt unchanged after rejected PATCH");

    // 7. Ingest: catch-all receives shareable memories; personal are never tagged
    log("7/9 ingest with the catch-all group id…");
    const job = await client.memories.ingest(
      {
        messages: [
          {
            role: "user",
            content:
              "Two things to remember. First: the team standup moved to 9:30am on Tuesdays, in the Aurora conference room. " +
              "Second, and this is private, just for me: I have been seeing a therapist every Thursday for my anxiety.",
          },
          { role: "assistant", content: "Got it — standup is Tuesdays 9:30am in Aurora, and I'll keep the second note private." },
        ],
        user_id: userId,
        conv_id: `${userId}_conv`,
        group_ids: [catchAll.id],
        extract_artifacts: false,
      },
      { wait: true },
    );
    const done = job.status === "succeeded" || job.status === "failed"
      ? job
      : await client.memories.jobs.pollUntilDone(job.id, { timeoutMs: 120_000 });
    assert(done.status === "succeeded", `ingest job succeeded (got ${done.status}: ${JSON.stringify(done.error)})`);
    assert(done.result !== null, "ingest job has a result");
    assert(done.result.ignored_group_ids.length === 0, "active catch-all id was not ignored");
    const refs = [...done.result.memories_created, ...done.result.memories_updated];
    assert(refs.length > 0, "ingest extracted at least one memory");
    createdMemoryIds.push(...refs.map((r) => r.id));
    const memories: Memory[] = await Promise.all(refs.map((r) => client.memories.get(r.id)));
    for (const m of memories) log(`    memory ${m.id} [${m.type}] groups=${JSON.stringify(m.group_ids)}: ${m.text.slice(0, 80)}`);

    const tagged = memories.filter((m) => m.group_ids.includes(catchAll.id));
    const personal = memories.filter((m) => /therap|anxiet/i.test(m.text));
    softAssert(tagged.length > 0, "at least one shareable memory was tagged with the catch-all group");
    softAssert(
      personal.length > 0 && personal.every((m) => m.group_ids.length === 0),
      "the personal (therapy) memory exists and carries NO group tags",
    );

    // 8. Archived catch-all is dropped and echoed back
    log("8/9 ingest with an ARCHIVED catch-all id…");
    const archived = await client.groups.create({ name: `grpsmoke archived ${runId}` });
    createdGroupIds.push(archived.id);
    await client.groups.archive(archived.id);
    const job2 = await client.memories.ingest(
      {
        messages: [{ role: "user", content: "The quarterly planning doc is due on the 15th." }],
        user_id: userId,
        conv_id: `${userId}_conv2`,
        group_ids: [archived.id],
        extract_artifacts: false,
      },
      { wait: true },
    );
    const done2 = job2.status === "succeeded" || job2.status === "failed"
      ? job2
      : await client.memories.jobs.pollUntilDone(job2.id, { timeoutMs: 120_000 });
    assert(done2.status === "succeeded", "archived-group ingest succeeded");
    assert(
      done2.result !== null && done2.result.ignored_group_ids.includes(archived.id),
      "archived catch-all id echoed in ignored_group_ids",
    );
    createdMemoryIds.push(...(done2.result?.memories_created ?? []).map((r) => r.id));
    log("    ignored_group_ids:", JSON.stringify(done2.result?.ignored_group_ids));
  } finally {
    // 9. Cleanup
    log("9/9 cleanup…");
    for (const id of createdMemoryIds) {
      await client.memories.delete(id).catch((e) => log(`    (memory ${id} cleanup failed: ${e})`));
    }
    for (const id of createdGroupIds) {
      await client.groups.archive(id).catch((e) => log(`    (group ${id} cleanup failed: ${e})`));
    }
    log(`    archived ${createdGroupIds.length} groups, deleted ${createdMemoryIds.length} memories`);
  }

  if (softFailures.length > 0) {
    log(`DONE — hard assertions passed; ${softFailures.length} classifier-dependent check(s) need eyeballing:`);
    for (const f of softFailures) log(`  ⚠ ${f}`);
    process.exit(1);
  }
  log("ALL CHECKS PASSED ✓");
}

main().catch((err) => {
  console.error("[groups-smoke] FAILED:", err);
  process.exit(1);
});
