/**
 * Vercel AI SDK integration: memory-aware model wrapper.
 *
 * `createXtraceMemory(opts)` returns a function that wraps any
 * `LanguageModel` (typically from `@ai-sdk/openai`, `@ai-sdk/anthropic`,
 * etc.) and injects xtrace memory around each call:
 *
 *   1. Before generation: search the user's memory for facts relevant
 *      to the latest user message, prepend them as a system block.
 *   2. After generation: ingest the user+assistant turn back into
 *      xtrace so the next turn can use it.
 *
 * Usage:
 *
 *   import { streamText } from 'ai';
 *   import { openai } from '@ai-sdk/openai';
 *   import { createXtraceMemory } from '@xtraceai/memory/ai-sdk';
 *
 *   const xtrace = createXtraceMemory({
 *     apiKey: process.env.XTRACE_API_KEY!,
 *     orgId:  process.env.XTRACE_ORG_ID!,
 *     user_id: 'alice',
 *     conv_id: 'conv_42',
 *   });
 *
 *   const result = streamText({
 *     model: xtrace(openai('gpt-4o-mini')),
 *     messages,
 *   });
 */
import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { MemoryClient } from "../client.js";

export interface CreateXtraceMemoryOptions {
  /** xtrace API key (`xtk_…`). */
  apiKey: string;
  /** xtrace organization id. */
  orgId: string;
  /** Override the xtrace base URL. Defaults to production. */
  baseUrl?: string;
  /** Scope: the user whose memories drive context and receive ingests. */
  user_id: string;
  /** Scope: the conversation anchor for ingests. */
  conv_id: string;
  /** How many memories to fetch as context per turn. Default 8. */
  searchLimit?: number;
  /**
   * Inject retrieved memories as a leading system message. Default
   * `true`. Set to `false` to disable auto-context (still runs
   * auto-ingest unless `autoIngest` is also disabled).
   */
  injectContext?: boolean;
  /**
   * Ingest the user+assistant turn back into memory after each
   * completion. Default `true`. Set to `false` to disable.
   */
  autoIngest?: boolean;
  /**
   * Inject a custom MemoryClient instance instead of building one
   * from `apiKey` + `orgId`. Useful for testing or sharing a single
   * client across the app.
   */
  client?: MemoryClient;
}

type ResolvedOptions = Required<Omit<CreateXtraceMemoryOptions, "client" | "baseUrl">> & {
  baseUrl?: string;
};

/**
 * Create the xtrace memory wrapper. Call the returned function on any
 * `LanguageModel` to get a memory-aware version of it.
 */
export function createXtraceMemory(
  options: CreateXtraceMemoryOptions,
): (model: LanguageModel) => LanguageModel {
  const client =
    options.client ??
    new MemoryClient({
      apiKey: options.apiKey,
      orgId: options.orgId,
      baseUrl: options.baseUrl,
    });

  const resolved: ResolvedOptions = {
    apiKey: options.apiKey,
    orgId: options.orgId,
    baseUrl: options.baseUrl,
    user_id: options.user_id,
    conv_id: options.conv_id,
    searchLimit: options.searchLimit ?? 8,
    injectContext: options.injectContext ?? true,
    autoIngest: options.autoIngest ?? true,
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3" as const,
    transformParams: async ({ params }) => {
      if (!resolved.injectContext) return params;

      const promptMessages = (params.prompt ?? []) as Array<{
        role: string;
        content: unknown;
      }>;
      const lastUser = [...promptMessages].reverse().find((m) => m.role === "user");
      const queryText = extractText(lastUser?.content);
      if (!queryText) return params;

      try {
        const { data } = await client.memories.search({
          query: queryText,
          filters: { user_id: resolved.user_id },
          limit: resolved.searchLimit,
        });
        if (data.length === 0) return params;

        const contextBlock =
          "Memory context — what you already know about this user from prior conversations:\n" +
          data.map((m) => `- ${m.text}`).join("\n");

        return {
          ...params,
          prompt: [
            { role: "system", content: contextBlock },
            ...promptMessages,
          ] as typeof params.prompt,
        };
      } catch (err) {
        // Search failure shouldn't break the LLM call — log + pass through.
        // eslint-disable-next-line no-console
        console.error("[xtrace ai-sdk] memory.search failed:", err);
        return params;
      }
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      if (resolved.autoIngest) {
        const text = extractTextFromGenerateResult(result);
        void ingestTurn(client, resolved, params.prompt, text);
      }
      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const { stream, ...rest } = await doStream();
      if (!resolved.autoIngest) return { stream, ...rest };

      let assistantText = "";
      const transformed = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            // v6 stream chunks: text deltas carry the partial text on
            // `chunk.delta`. Other part types (tool calls, reasoning,
            // etc.) we don't ingest.
            const c = chunk as { type?: string; delta?: string };
            if (c.type === "text-delta" && typeof c.delta === "string") {
              assistantText += c.delta;
            }
          },
          flush() {
            void ingestTurn(client, resolved, params.prompt, assistantText);
          },
        }),
      );
      return { stream: transformed, ...rest };
    },
  };

  return function wrap(model: LanguageModel): LanguageModel {
    // `wrapLanguageModel` requires a v3 model instance. `LanguageModel`
    // is `string | LanguageModelV2 | LanguageModelV3`; callers
    // typically pass `openai('gpt-4o-mini')` etc. which is V3 today.
    // Cast through `unknown` because the public type is the union.
    return wrapLanguageModel({
      model: model as unknown as Parameters<typeof wrapLanguageModel>[0]["model"],
      middleware,
    });
  };
}

// ── helpers ────────────────────────────────────────────────────────

async function ingestTurn(
  client: MemoryClient,
  config: { user_id: string; conv_id: string },
  prompt: unknown,
  assistantText: string,
): Promise<void> {
  const promptMessages = (prompt ?? []) as Array<{ role: string; content: unknown }>;
  const lastUser = [...promptMessages].reverse().find((m) => m.role === "user");
  const userText = extractText(lastUser?.content);
  if (!userText || !assistantText.trim()) return;

  try {
    await client.memories.ingest(
      {
        messages: [
          { role: "user", content: userText },
          { role: "assistant", content: assistantText },
        ],
        user_id: config.user_id,
        conv_id: config.conv_id,
        extract_artifacts: false,
      },
      { wait: true },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xtrace ai-sdk] auto-ingest failed:", err);
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

function extractTextFromGenerateResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const r = result as { content?: unknown; text?: unknown };
  if (Array.isArray(r.content)) {
    return r.content
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join("");
  }
  if (typeof r.text === "string") return r.text;
  return "";
}
