/**
 * Vercel AI SDK integration: directive recall as a pre-tool-call hook.
 *
 * Where {@link createXtraceMemory} recalls *semantic* memory once per generation
 * on the user message, directives fire per *tool call* on what the agent is about
 * to touch. `withDirectiveRecall(tools, opts)` wraps a tools object so that BEFORE
 * each tool runs, the directives keyed to that tool's `{ name, args }` are recalled
 * (the symbol tripwire) and prepended to the tool's result — so the model sees the
 * relevant lesson/procedure alongside what the tool did, before its next move.
 *
 * Usage:
 *
 *   import { streamText } from 'ai';
 *   import { openai } from '@ai-sdk/openai';
 *   import { MemoryClient } from '@xtraceai/memory';
 *   import { withDirectiveRecall } from '@xtraceai/memory/ai-sdk';
 *
 *   const client = new MemoryClient({ apiKey, orgId });
 *   const result = streamText({
 *     model: openai('gpt-4o-mini'),
 *     tools: withDirectiveRecall(myTools, { client, user_id: 'alice' }),
 *     messages,
 *   });
 */
import type { MemoryClient } from "../client.js";
import { renderDirectivesPrompt } from "../memories.js";
import type { DirectiveMemory, SearchMode } from "../types.js";

export interface DirectiveRecallScope {
  /** Scope directive recall to this user's directives. */
  user_id?: string;
  /** Optional agent scope (AND-narrows). */
  agent_id?: string;
  /** Optional app scope (AND-narrows). */
  app_id?: string;
  /** Optional shared group scope (any-of). */
  group_ids?: string[];
}

export interface DirectiveRecallOptions extends DirectiveRecallScope {
  /** The memory client used to recall. */
  client: MemoryClient;
  /**
   * `"retrieve"` (default) — the deterministic stage-1 tripwire, fast (~0.1s),
   * right for a per-tool-call hook. `"compose"` adds the stage-2 LLM gate.
   */
  mode?: SearchMode;
  /** Max directives per tool call. Default 5. */
  limit?: number;
  /**
   * Prepend the recalled directives to the tool's (string) result so the model
   * reads them. Default `true`. Set `false` to leave results untouched and rely
   * on {@link DirectiveRecallOptions.onDirectives} for handling.
   */
  injectIntoResult?: boolean;
  /** Called whenever directives fire for a tool call — for logging / telemetry. */
  onDirectives?: (directives: DirectiveMemory[], toolName: string) => void;
}

/**
 * Recall the directives for one in-flight tool call → rendered context (or `""`).
 * Fails soft: a recall error returns no directives rather than throwing.
 */
export async function directiveContextForToolCall(
  opts: DirectiveRecallOptions,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ directives: DirectiveMemory[]; context: string }> {
  try {
    const { data, context } = await opts.client.memories.recallDirectives({
      action: { tool: toolName, args },
      user_id: opts.user_id,
      agent_id: opts.agent_id,
      app_id: opts.app_id,
      group_ids: opts.group_ids,
      mode: opts.mode ?? "retrieve",
      limit: opts.limit ?? 5,
    });
    return { directives: data, context: context ?? renderDirectivesPrompt(data) };
  } catch {
    return { directives: [], context: "" };
  }
}

/**
 * Wrap a Vercel AI SDK tools object with pre-tool-call directive recall. Tools
 * with no `execute` are passed through untouched; a recall hiccup never breaks a
 * tool (fail-soft).
 */
export function withDirectiveRecall<T extends Record<string, unknown>>(
  tools: T,
  opts: DirectiveRecallOptions,
): T {
  const inject = opts.injectIntoResult ?? true;
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const tool = t as { execute?: (...a: unknown[]) => unknown } & Record<string, unknown>;
    if (typeof tool?.execute !== "function") {
      out[name] = t;
      continue;
    }
    const originalExecute = tool.execute.bind(tool);
    out[name] = {
      ...tool,
      execute: async (args: Record<string, unknown>, execCtx: unknown) => {
        const { directives, context } = await directiveContextForToolCall(
          opts,
          name,
          args ?? {},
        );
        if (directives.length && opts.onDirectives) opts.onDirectives(directives, name);
        const result = await originalExecute(args, execCtx);
        if (inject && context && typeof result === "string") {
          return `${context}\n\n${result}`;
        }
        return result;
      },
    };
  }
  return out as T;
}
