/**
 * Vercel AI SDK integration for `@xtraceai/memory`.
 *
 * Two patterns:
 *
 * 1. `createXtraceMemory(opts)` — wrap any `LanguageModelV2` so it
 *    auto-injects memory context before each call and ingests the
 *    turn after. The "memory just works" pattern.
 *
 * 2. `memoryTools(client, scope)` — expose `search_memory` and
 *    `save_memory` as tools the LLM can call deliberately. The
 *    "LLM in control" pattern.
 *
 * Pick one, or both — they don't conflict.
 *
 * Requires `ai >= 5` and `zod >= 3.23` as peer dependencies.
 */
export { createXtraceMemory } from "./provider.js";
export type { CreateXtraceMemoryOptions } from "./provider.js";

export { memoryTools } from "./tools.js";
export type { MemoryToolsScope, MemoryToolsOptions } from "./tools.js";
