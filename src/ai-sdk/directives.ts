/**
 * Vercel AI SDK integration: procedural-memory (directive) recall around tools.
 *
 * `withDirectiveRecall(tools, client, scope)` wraps every tool's `execute`
 * with the symbol tripwire (`POST /v1/memories/trigger`):
 *
 *   1. **Pre-tool**: as the tool runs, recall the `lesson` / `procedure`
 *      directives past sessions recorded about the identifiers in this call
 *      (the tool name, the ids/paths in its args). Recall runs CONCURRENTLY
 *      with the tool — it never delays execution.
 *   2. **Reactive**: when the tool's result looks like a failure, recall
 *      again with the error text as `output` — a traceback or API error
 *      names the true cause (identifiers the args never showed).
 *   3. **Inject**: fired directives are appended to the tool result (string
 *      results get a `<team-directives>` tail; plain-object results get an
 *      `xtrace_team_directives` field), so the model reads them at its next
 *      step — the moment it decides what to do with the result.
 *
 * A directive fires at most once per wrapper instance (create one wrapper
 * per conversation): fired ids thread back as `already_fired`. Everything is
 * fail-open and time-bounded — a slow or failing recall never blocks, breaks,
 * or reshapes a tool call.
 *
 * Usage:
 *
 *   import { streamText } from 'ai';
 *   import { MemoryClient } from '@xtraceai/memory';
 *   import { withDirectiveRecall } from '@xtraceai/memory/ai-sdk';
 *
 *   const client = new MemoryClient({ apiKey, orgId });
 *   const tools = withDirectiveRecall(myTools, client, {
 *     agent_id: 'billing-agent',
 *     namespace: 'acct:acme-corp',   // the working context used at ingest
 *   });
 *   const result = streamText({ model, tools, messages });
 */
import type { MemoryClient } from "../client.js";
import type { DirectiveMemory, SearchListEnvelope, TriggerRequest } from "../types.js";

export interface DirectiveRecallScope {
  /** Tenancy axes — at least one is required by the server. */
  user_id?: string;
  agent_id?: string;
  app_id?: string;
  group_ids?: string[];
  /**
   * Working-context name used at ingest (a repo, a customer account, a
   * service). Narrows recall to directives learned there plus global ones —
   * never hides globals, so it is always safe to pass.
   */
  namespace?: string;
  /** One-line description of the agent's current goal (feeds the relevance gate). */
  task?: string;
}

export interface DirectiveRecallOptions {
  /**
   * `"retrieve"` (default): deterministic tripwire only — sub-second, no LLM.
   * `"compose"`: adds the server's LLM relevance gate + an assembled context
   * block; higher precision, one LLM call per fire.
   */
  mode?: "retrieve" | "compose";
  /** Recall round-trip budget in ms (default 1500). On timeout: no injection. */
  timeoutMs?: number;
  /** Max directives injected per tool call (default 3). */
  maxDirectives?: number;
  /**
   * Also fire on failure-looking string results, sending the error text as
   * `output` so cause-anchored directives surface at the failure site.
   * Default `true`.
   */
  reactive?: boolean;
  /**
   * Observer for fired directives (fires whether or not they could be
   * injected into the result shape). Use it to inject via your own channel —
   * e.g. a system message on the next model call.
   */
  onDirectives?: (directives: DirectiveMemory[], toolName: string) => void;
}

/** Failure markers for the reactive pass — kept boring and high-precision. */
const ERROR_RE =
  /(?:Traceback \(most recent call last\)|\b[A-Z][a-zA-Z]*Error\b|\bERROR\b|\bError\b|error:|✘|npm ERR!|FAILED\b|fatal:|Exception\b)/;

const DIRECTIVE_FIELD = "xtrace_team_directives";

/** Minimal structural view of an AI SDK tool — only `execute` is touched. */
interface ExecutableTool {
  execute?: (args: unknown, options: unknown) => PromiseLike<unknown> | unknown;
}

/**
 * Wrap a `tools` object so every tool call recalls and injects the team's
 * situated directives. Returns the same shape it was given; tools without an
 * `execute` (client-side/provider-executed tools) pass through untouched.
 */
export function withDirectiveRecall<TOOLS extends Record<string, unknown>>(
  tools: TOOLS,
  client: MemoryClient,
  scope: DirectiveRecallScope,
  options: DirectiveRecallOptions = {},
): TOOLS {
  const mode = options.mode ?? "retrieve";
  const timeoutMs = options.timeoutMs ?? 1500;
  const maxDirectives = options.maxDirectives ?? 3;
  const reactive = options.reactive ?? true;
  // One wrapper = one conversation's dedup horizon. Ids are recorded only
  // when a directive was actually surfaced (injected or observed), so a
  // gate-dropped candidate keeps its chance at its real moment later.
  const fired = new Set<string>();

  async function recall(body: Omit<TriggerRequest, keyof DirectiveRecallScope>) {
    const req: TriggerRequest = {
      ...body,
      user_id: scope.user_id,
      agent_id: scope.agent_id,
      app_id: scope.app_id,
      group_ids: scope.group_ids,
      namespace: scope.namespace,
      task: scope.task,
      mode,
    };
    // Time-bound and fail-open: a memory lookup must never stall a tool.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    try {
      const res = await Promise.race([client.memories.trigger(req), timeout]);
      if (!res) return [];
      const rows = ((res as SearchListEnvelope).data ?? []) as DirectiveMemory[];
      return rows
        .filter((d) => d && (d.type === "lesson" || d.type === "procedure") && !fired.has(d.id))
        .slice(0, maxDirectives);
    } catch {
      return [];
    }
  }

  function surface(directives: DirectiveMemory[], toolName: string): void {
    for (const d of directives) fired.add(d.id);
    try {
      options.onDirectives?.(directives, toolName);
    } catch {
      /* observer errors never break the tool call */
    }
  }

  function render(directives: DirectiveMemory[]): string {
    const lines = directives.map((d) => `- [${d.type.toUpperCase()}] ${d.text}`);
    return (
      "<team-directives>\n" +
      "Situated lessons/procedures your team recorded about what this tool call touches — act on them:\n" +
      lines.join("\n") +
      "\n</team-directives>"
    );
  }

  /** Attach directives to the result without breaking its shape. */
  function inject(result: unknown, directives: DirectiveMemory[]): unknown {
    if (directives.length === 0) return result;
    if (typeof result === "string") {
      return `${result}\n\n${render(directives)}`;
    }
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), [DIRECTIVE_FIELD]: render(directives) };
    }
    // Arrays / numbers / undefined: no safe seam — the onDirectives observer
    // (already notified via surface()) is the injection channel.
    return result;
  }

  const wrapped: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const original = t as ExecutableTool;
    if (typeof original?.execute !== "function") {
      wrapped[name] = t; // provider-executed / no-execute tool — untouched
      continue;
    }
    const originalExecute = original.execute.bind(original);
    wrapped[name] = {
      ...(t as Record<string, unknown>),
      execute: async (args: unknown, callOptions: unknown) => {
        // Pre-tool recall runs concurrently — the tool is never delayed.
        const preRecall = recall({
          action: { tool: name, args: (args ?? {}) as Record<string, unknown> },
        });
        const result = await originalExecute(args, callOptions);
        let directives = await preRecall;

        // Reactive pass: a failure-looking string result names the true
        // cause — identifiers the args never showed. One extra recall,
        // same dedup horizon.
        if (reactive && typeof result === "string" && ERROR_RE.test(result.slice(-2000))) {
          const more = await recall({
            action: {
              tool: name,
              args: (args ?? {}) as Record<string, unknown>,
              output: result.slice(-1500),
            },
          });
          const seen = new Set(directives.map((d) => d.id));
          directives = [...directives, ...more.filter((d) => !seen.has(d.id))].slice(
            0,
            maxDirectives,
          );
        }

        if (directives.length === 0) return result;
        surface(directives, name);
        return inject(result, directives);
      },
    };
  }
  return wrapped as TOOLS;
}
