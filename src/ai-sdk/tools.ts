/**
 * Vercel AI SDK integration: memory tools for the LLM to call.
 *
 * Alternative to the wrapper-provider pattern from `./provider.ts`.
 * Instead of auto-injecting memory around every call, exposes
 * `search_memory` and `save_memory` as tools the model can call
 * deliberately. Useful when:
 *
 *   - You want the model in control (cheaper — no search on every turn)
 *   - You want both reads AND writes the model decides to make
 *   - You're already using tools for other things and want a uniform pattern
 *
 * Usage:
 *
 *   import { streamText } from 'ai';
 *   import { openai } from '@ai-sdk/openai';
 *   import { MemoryClient } from '@xtraceai/memory';
 *   import { memoryTools } from '@xtraceai/memory/ai-sdk';
 *
 *   const client = new MemoryClient({ apiKey, orgId });
 *   const result = streamText({
 *     model: openai('gpt-4o-mini'),
 *     tools: memoryTools(client, { user_id: 'alice', conv_id: 'conv_42' }),
 *     messages,
 *   });
 */
import { tool } from "ai";
import { z } from "zod";
import type { MemoryClient } from "../client.js";

export interface MemoryToolsScope {
  /** Scope memory searches and ingests to this user. */
  user_id: string;
  /** Scope ingests to this conversation. */
  conv_id: string;
}

export interface MemoryToolsOptions {
  /** Override the default search limit per tool call (default 5). */
  searchLimit?: number;
  /**
   * If true (default), expose `save_memory` so the model can write.
   * Set false to keep memory read-only from the model's perspective.
   */
  includeSave?: boolean;
}

/**
 * Build a set of memory tools the LLM can call. Returns an object
 * suitable for passing as `tools: ...` to `streamText` / `generateText`.
 */
export function memoryTools(
  client: MemoryClient,
  scope: MemoryToolsScope,
  options: MemoryToolsOptions = {},
) {
  const searchLimit = options.searchLimit ?? 5;
  const includeSave = options.includeSave ?? true;

  const search_memory = tool({
    description:
      "Search the user's stored memory for relevant facts. Use when " +
      "you need context the current turn doesn't provide (e.g. the " +
      "user's preferences, prior decisions, or details they mentioned " +
      "in earlier sessions).",
    inputSchema: z.object({
      query: z
        .string()
        .describe("Natural-language description of what to look for."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many memories to return. Default 5."),
    }),
    execute: async ({ query, limit }) => {
      const { data } = await client.memories.search({
        query,
        filters: { user_id: scope.user_id },
        limit: limit ?? searchLimit,
      });
      return data.map((m) => ({
        id: m.id,
        text: m.text,
        score: m.score,
      }));
    },
  });

  if (!includeSave) {
    return { search_memory };
  }

  const save_memory = tool({
    description:
      "Save a durable fact about the user to memory. Use sparingly — " +
      "only for things worth remembering across sessions, written as " +
      "a third-person statement (e.g. \"User prefers concise responses\" " +
      "or \"User is allergic to peanuts\").",
    inputSchema: z.object({
      fact: z.string().describe("The fact to remember."),
    }),
    execute: async ({ fact }) => {
      const job = await client.memories.ingest(
        {
          messages: [{ role: "user", content: fact }],
          user_id: scope.user_id,
          conv_id: scope.conv_id,
          extract_artifacts: false,
        },
        { wait: true },
      );
      return {
        status: job.status,
        created: job.result?.memories_created?.length ?? 0,
      };
    },
  });

  return { search_memory, save_memory };
}
