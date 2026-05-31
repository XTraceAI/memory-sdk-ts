// Hand-written types matching openapi/memory_v2.json.
// Regenerate the canonical version with `npm run gen:types` once the spec is final.

export type MemoryType = "fact" | "artifact" | "episode";

export type Role = "user" | "assistant" | "system";

export interface Message {
  role: Role;
  content: string;
  /** Optional ISO-8601 timestamp of the turn. Used only by the batch path. */
  date?: string;
  /** Optional client-supplied per-turn id (carried for trace/eval). */
  dia_id?: string;
}

export type MemoryStatus = "active" | "superseded" | "retracted";

/**
 * Type-specific extension for a `fact` memory. Every scalar field can come
 * back null from the wire (Pydantic optional types); the unions reflect that.
 */
export interface FactDetails {
  fact_type: string | null;
  status: MemoryStatus | null;
  supersedes: string | null;
  source_role: Role | null;
  episode_id: string | null;
  artifact_id: string | null;
  artifact_ids: string[];
  source_event_ids: string[];
}

/**
 * Type-specific extension for an `artifact` memory. `full_content` is the
 * heavy field — omitted from list/search responses by default; opt in via
 * `include: ["full_content"]`.
 */
export interface ArtifactDetails {
  title: string | null;
  rationale: string | null;
  version: number | null;
  root_id: string | null;
  source_fact_ids: string[];
  episode_ids: string[];
  full_content?: string | null;
}

/** Type-specific extension for an `episode` memory. */
export interface EpisodeDetails {
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  fact_ids: string[];
  artifact_ids: string[];
}

interface MemoryBase<T extends MemoryType, D> {
  id: string;
  object: "memory";
  type: T;
  text: string;
  user_id: string | null;
  agent_id: string | null;
  conv_id: string | null;
  app_id: string | null;
  /** Group tags applied by the ingest-time classifier (see `POST /v1/groups`). */
  group_ids: string[];
  categories: string[];
  score: number | null;
  created_at: string;
  updated_at: string;
  details: D;
  expanded?: Record<string, Memory[]>;
}

export type FactMemory = MemoryBase<"fact", FactDetails>;
export type ArtifactMemory = MemoryBase<"artifact", ArtifactDetails>;
export type EpisodeMemory = MemoryBase<"episode", EpisodeDetails>;
export type Memory = FactMemory | ArtifactMemory | EpisodeMemory;

export interface IngestRequest {
  messages: Message[];
  /** Required. Keys the per-user session namespace and is an indexed filter axis. */
  user_id: string;
  /** Required. Anchors every extracted memory to a conversation. */
  conv_id: string;
  agent_id?: string;
  app_id?: string;
  /**
   * `strptime` format for parsing each message's `date` on the batch path
   * (e.g. `"%Y-%m-%d %H:%M:%S"`). Ignored by the live path.
   */
  timestamp_format?: string;
  /** Run the artifact-extraction stage. Defaults to `true` in the SDK; pass `false` to skip it. */
  extract_artifacts?: boolean;
  /**
   * Group ids to associate with this ingest — the classifier tags each
   * extracted memory with the subset it belongs to. Each must be a registered
   * group (`POST /v1/groups`); unknown / archived ids are dropped and echoed
   * back in `IngestJobResult.ignored_group_ids`.
   */
  group_ids?: string[];
}

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

/** Thin reference returned in `IngestJobResult.memories_created` / `memories_updated`. */
export interface MemoryRef {
  id: string;
  type: MemoryType;
  text: string;
}

export interface IngestJobResult {
  object?: "ingest_result";
  memories_created: MemoryRef[];
  memories_updated: MemoryRef[];
  memories_superseded_by: Record<string, string>;
  stage_timings: Record<string, number>;
  /** Requested `group_ids` the server dropped (unknown / archived) — echoed back so clients can prune stale ids. */
  ignored_group_ids: string[];
}

/**
 * Returned by every `POST /v1/memories` call. With `wait: true`, the response
 * may already be terminal (`status: "succeeded"` and `result` populated) — no
 * polling needed. Otherwise call `client.memories.jobs.pollUntilDone(job.id)`.
 */
export interface IngestJob {
  object: "ingest_job";
  id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  result: IngestJobResult | null;
  error: { code: string; message: string } | null;
}

export interface ListEnvelope<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SearchListEnvelope extends ListEnvelope<Memory> {
  /**
   * Assembled context block, present only when `mode: "compose"`. This is
   * the LLM-selected, ready-to-inject prompt for the single scope searched.
   * Null under `mode: "retrieve"`.
   */
  context?: string | null;
  extras?: {
    context_prompt?: string;
    stage_timings?: Record<string, number>;
  };
}

export type Filter = Record<string, unknown>;

export interface ListQuery {
  user_id?: string;
  agent_id?: string;
  conv_id?: string;
  app_id?: string;
  type?: MemoryType;
  cursor?: string;
  limit?: number;
  order?: "created_at_desc" | "created_at_asc";
  include?: Array<"full_content">;
}

/** Per-scope search mode.
 * - `"compose"` (server default) runs the LLM context-selection pass: `data`
 *   is the agent-filtered subset and `context` is an assembled prompt string.
 * - `"retrieve"` skips the LLM: `data` is the raw vector-ranked candidate set
 *   and `context` is null. Cheaper / faster.
 */
export type SearchMode = "compose" | "retrieve";

export interface SearchRequest {
  query: string;
  /** Scope axis — the caller's own memories. AND-narrows results when set. */
  user_id?: string;
  /**
   * Shared group tags (any-of within the list). AND-narrows when set. Omit
   * `user_id` and pass this for a cross-user whole-group read; pass both for
   * the caller's own slice of the group (intersection).
   */
  group_ids?: string[];
  /** Optional agent scope. AND-narrows results when set. */
  agent_id?: string;
  /** Optional app scope. AND-narrows results when set. */
  app_id?: string;
  /** Search mode. Defaults server-side to `"compose"`. */
  mode?: SearchMode;
  limit?: number;
  cursor?: string | null;
  include?: Array<"context_prompt" | "full_content">;
  /**
   * @deprecated Legacy pre-#68 wire shape. The server still lifts
   * `user_id` / `agent_id` / `app_id` out of here, but new code should use
   * the top-level fields above.
   */
  filters?: Filter;
}

/** Parameters for {@link Memories.recall} — a personal + shared (group) read. */
export interface RecallParams {
  /** Natural-language query, embedded server-side. */
  query: string;
  /** Personal scope. Include to pull the caller's own memories. */
  user_id?: string;
  /** Shared scope. Include to pull group-tagged memories (any-of). */
  group_ids?: string[];
  /** Optional agent scope — AND-narrows every sub-search. */
  agent_id?: string;
  /** Optional app scope — AND-narrows every sub-search. */
  app_id?: string;
  /**
   * Per-scope search mode. `"compose"` (default) returns each scope's
   * agent-filtered rows — recommended, since recall dedupes those into one
   * prompt. `"retrieve"` returns raw rows (no LLM filtering).
   */
  mode?: SearchMode;
  /** Cap on the merged, deduped result. Default 10. */
  limit?: number;
}

/** Per-scope diagnostic returned by {@link Memories.recall}. */
export interface RecallScopeStat {
  scope: "personal" | "shared";
  /** Rows this scope contributed before the cross-scope dedupe. */
  count: number;
}

/** Result of {@link Memories.recall}: merged memories + a single prompt. */
export interface RecallResult {
  /** Deduped, score-ranked union of every scope's rows, capped to `limit`. */
  memories: Memory[];
  /** Ready-to-inject context block rendered from `memories` (one set, no duplicated framing). */
  prompt: string;
  /** Per-scope contribution counts (pre-dedupe), for debugging / observability. */
  scopes: RecallScopeStat[];
}

/**
 * Declarative spec for how {@link renderMemoriesPrompt} formats the prompt.
 * Deliberately JSON-serializable (data, not code): a future API endpoint can
 * return xmem's preferred template and the SDK renders with it — fetched once /
 * cached, so no per-call latency — instead of the server assembling each prompt.
 * Override per call via `recall(..., { template })`; see `DEFAULT_PROMPT_TEMPLATE`.
 *
 * Note: a template controls *formatting of the fields each row carries*. It can't
 * reproduce xmem features that need extra data (authorship sections, full
 * artifact bodies, char-budgeting) without also widening the search payload.
 */
export interface PromptTemplate {
  /** Leading line of the block. */
  header: string;
  /** Section header for personal (untagged) memories. */
  personalLabel: string;
  /** Section header for a group whose name didn't resolve; `{id}` is substituted. */
  unknownGroupLabel: string;
  /** Inline tag prepended per memory type (`""` = no tag), e.g. `artifact: "[document] "`. */
  typeLabels: Record<MemoryType, string>;
  /** Append `[cat, …]` per line when the memory has categories. */
  includeCategories: boolean;
  /** Append `(recorded YYYY-MM-DD)` per line when available. */
  includeRecordedDate: boolean;
}

// ── Groups (group registry — POST /v1/groups etc.) ─────────────────────────

export type GroupStatus = "active" | "archived";

/** A registered group: a tagging target with a prompt describing what belongs to it. */
export interface Group {
  object: "group";
  /** Server-generated handle, `grp_<32hex>`. */
  id: string;
  name: string;
  /** Describes when a memory belongs to this group — used by the ingest classifier. */
  prompt: string;
  status: GroupStatus;
  created_at: string;
  updated_at: string | null;
}

export interface GroupCreateRequest {
  name: string;
  prompt: string;
}

/** Partial update. Any field omitted is left unchanged. `status: "archived"` archives the group. */
export interface GroupUpdateRequest {
  name?: string;
  prompt?: string;
  status?: GroupStatus;
}

export interface GroupListEnvelope {
  object: "list";
  data: Group[];
}

export interface ApiErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    request_id?: string;
    details?: Record<string, unknown>;
  };
}
