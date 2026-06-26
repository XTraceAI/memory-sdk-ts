/**
 * Dogfood: a real agent loop with vs. without directive recall.
 *
 * The agent is asked to make the judge model in `scripts/memory_quality_sweep.py`
 * configurable. A captured lesson from a real session says exactly how we like it
 * done — "thread `judge_model` through the scoring path instead of hardcoding
 * `JUDGE_MODEL`". With `withDirectiveRecall`, that lesson fires the moment the agent
 * reads the file and is injected into the read result, so the agent's edit follows
 * the team convention. Without it, the agent guesses.
 *
 * Run:  cd memory-sdk-ts && npx tsx examples/agent_loop_demo.ts
 *   env: OPENAI_API_KEY (gpt-4o-mini via @ai-sdk/openai), XTRACE_API_KEY, XTRACE_ORG_ID,
 *        optional XTRACE_USER_ID (the user whose directives to recall), XTRACE_BASE_URL.
 */
import { generateText, stepCountIs, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { MemoryClient } from "../src/index.js";
import { withDirectiveRecall } from "../src/ai-sdk/index.js";

const XTRACE_API_KEY = process.env.XTRACE_API_KEY!;
const XTRACE_ORG_ID = process.env.XTRACE_ORG_ID!;
const USER_ID = process.env.XTRACE_USER_ID ?? "directive-real-0625";

// The file the agent will work on (hardcoded judge model — the thing to refactor).
const FILE = "scripts/memory_quality_sweep.py";
const FILE_CONTENT = `JUDGE_MODEL = "claude-haiku-4-5"  # hardcoded

def _score_one(fact, judge):
    resp = judge.classify(fact, model=JUDGE_MODEL)
    return resp.label

def run_sweep(facts):
    judge = AnthropicJudge()
    return [_score_one(f, judge) for f in facts]
`;

const client = new MemoryClient({
  apiKey: XTRACE_API_KEY,
  orgId: XTRACE_ORG_ID,
  baseUrl: process.env.XTRACE_BASE_URL ?? "https://api.staging.xtrace.ai",
});

function makeTools(record: { patch?: string }) {
  return {
    read_file: tool({
      description: "Read a source file. Returns its full text.",
      inputSchema: z.object({ file_path: z.string() }),
      execute: async () => FILE_CONTENT,
    }),
    propose_patch: tool({
      description: "Propose the final edited file. Call once you know the change.",
      inputSchema: z.object({ file_path: z.string(), new_content: z.string() }),
      execute: async ({ new_content }) => {
        record.patch = new_content;
        return "recorded";
      },
    }),
  };
}

const TASK =
  `Make the judge model in ${FILE} configurable so a caller can choose it per run. ` +
  `First read the file, then call propose_patch with the full edited file.`;

async function runOnce(useDirectives: boolean): Promise<string | undefined> {
  const record: { patch?: string } = {};
  const fired: string[] = [];
  const base = makeTools(record);
  const tools = useDirectives
    ? withDirectiveRecall(base, {
        client,
        user_id: USER_ID,
        mode: "retrieve",
        onDirectives: (ds) => fired.push(...ds.map((d) => `[${d.type}] ${d.text}`)),
      })
    : base;

  await generateText({
    model: openai("gpt-4o-mini"),
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    prompt: TASK,
    stopWhen: stepCountIs(5),
  });

  if (useDirectives) {
    console.log(`  directives that fired (${fired.length}):`);
    fired.forEach((f) => console.log(`    ↳ ${f.slice(0, 120)}`));
  }
  return record.patch;
}

(async () => {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not found");
  if (!XTRACE_API_KEY || !XTRACE_ORG_ID) throw new Error("set XTRACE_API_KEY + XTRACE_ORG_ID");

  console.log("=".repeat(72));
  console.log("RUN A — no directive recall (the agent guesses the convention)");
  console.log("=".repeat(72));
  const a = await runOnce(false);
  console.log("\n  proposed edit:\n" + indent(a));

  console.log("\n" + "=".repeat(72));
  console.log("RUN B — withDirectiveRecall (the team's lesson fires on read)");
  console.log("=".repeat(72));
  const b = await runOnce(true);
  console.log("\n  proposed edit:\n" + indent(b));

  const threadsB = /def\s+\w+\([^)]*judge_model|model=judge_model|judge_model:/.test(b ?? "");
  const threadsA = /def\s+\w+\([^)]*judge_model|model=judge_model|judge_model:/.test(a ?? "");
  console.log("\n" + "=".repeat(72));
  console.log(`threads judge_model through the call path?   A=${threadsA}   B=${threadsB}`);
  console.log("(the captured lesson: thread judge_model through, don't hardcode JUDGE_MODEL)");
})();

function indent(s?: string): string {
  return (s ?? "(no patch proposed)").split("\n").map((l) => "    " + l).join("\n");
}
