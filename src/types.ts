// Hand-authored domain types — the canonical public surface (ADR-002).
// The spec-derived reference lives at src/generated/types.ts; regenerate it
// with `npm run gen:types` (source: spec/memory.json) and keep it in sync via
// `npm run check:types-sync`. The generated file is a reference, not the
// public surface — these hand-authored types are.

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
  /**
   * **Deferred for 1.0** — typed but inert. No request-side `expand` parameter
   * exists on search/list/recall yet, so the server has no trigger to populate
   * this and it stays `undefined` in practice. The field is kept as a
   * forward-looking contract; it will be wired when the API documents an
   * `expand` request shape. See ADR-002 (C2: `Memory.expanded` / `expand` →
   * defer, no documented request trigger).
   */
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
   * Filter DSL over indexed payload keys — operators (`$eq`/`$in`/`$gt`/…),
   * `null` for "unset", and `AND`/`OR`/`NOT` composition; top-level keys are
   * implicit-AND'd. Build it with the typed `f` builder (`src/filter.ts`) or
   * pass a raw {@link Filter} object. This operator-DSL use is **supported and
   * not deprecated**.
   *
   * @deprecated *only* for lifting the scope axes
   * (`user_id` / `agent_id` / `app_id`) out of here — that legacy pre-#68 form
   * still works (the server lifts them) but new code should set those as the
   * top-level fields above. Filtering on non-scope payload keys via the
   * operator DSL is the supported, non-deprecated use of this field.
   */
  filters?: Filter;
}

/**
 * One scoped search whose results {@link Memories.recall} unions with the others.
 * Axes within a pool **AND** together (a normal scoped search); recall **unions**
 * the pools, dedupes, ranks, and renders one prompt.
 */
export interface ScopePool {
  user_id?: string;
  group_ids?: string[];
  agent_id?: string;
  app_id?: string;
}

/** Parameters for {@link Memories.recall} — a union of independent scope pools. */
export interface RecallParams {
  /** Natural-language query, embedded server-side. */
  query: string;
  /**
   * The scope pools to union. Each pool is one scoped search — its axes AND
   * together — and recall unions the pools, dedupes, score-ranks, and renders
   * one prompt. At least one pool (each with ≥1 axis) is required.
   *
   * The only OR in the API: axes within a pool AND; pools OR. So put each scope
   * you want OR'd in its own pool.
   *
   * @example
   * // personal + a group ("my stuff OR the trip's stuff"):
   * pools: [{ user_id: "alice" }, { group_ids: ["grp_tokyo"] }]
   * @example
   * // personal + a global app_id knowledge base:
   * pools: [{ user_id: "alice" }, { app_id: "product-kb" }]
   * @example
   * // AND inside a pool, OR across: (alice AND planner) OR product-kb
   * pools: [{ user_id: "alice", agent_id: "planner" }, { app_id: "product-kb" }]
   */
  pools: ScopePool[];
  /**
   * Per-pool search mode. `"compose"` (default) returns each pool's
   * agent-filtered rows — recommended, since recall dedupes those into one
   * prompt. `"retrieve"` returns raw rows (no LLM filtering).
   */
  mode?: SearchMode;
  /** Cap on the merged, deduped result. Default 10. */
  limit?: number;
  /**
   * Heavy fields to fetch on the returned rows. Forwarded to **every** per-pool
   * search, so a single recall enriches the merged set without follow-up `get()`
   * calls — e.g. `include: ["full_content"]` makes `ArtifactDetails.full_content`
   * available on artifact rows.
   *
   * Scoped to `"full_content"` only (NOT the `"context_prompt"` that
   * {@link SearchRequest} accepts): recall discards each pool's
   * {@link SearchListEnvelope} — it dedupes/re-ranks the rows and renders **one**
   * client-side prompt, returning `{ memories, prompt, scopes }` with no per-pool
   * `extras` channel — so a requested `context_prompt` would only make the server
   * assemble prompts recall then throws away. Use {@link Memories.search} /
   * {@link Memories.retrieve} (which return the envelope intact) when you need the
   * per-scope `context_prompt`.
   */
  include?: Array<"full_content">;
}

/** Per-pool diagnostic returned by {@link Memories.recall}. */
export interface RecallScopeStat {
  /** Pool label: `"personal"` (user-only), `"shared"` (has group_ids), else `"scope"`. */
  scope: string;
  /** Rows this pool contributed before the cross-pool dedupe. */
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
 *
 * **Server-supplied templates are deferred for 1.0.** The type is fully usable
 * today as a client-side override (`recall(..., { template })`), but the
 * "future API endpoint returns xmem's preferred template" path above is
 * **not yet implemented** — no server endpoint returns a `PromptTemplate`, so
 * the SDK ships the {@link DEFAULT_PROMPT_TEMPLATE} and does not fetch one. The
 * type stays as a forward contract; the fetch/cache path is wired when the
 * server exposes it. See ADR-002 (C2: server-supplied `PromptTemplate` → defer,
 * no server endpoint; client default suffices).
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
  /**
   * Prefix each shared (group) line with its author — `"<user_id>: "`, or
   * `"you: "` when it's the caller's own row — so the agent can tell whose
   * fact it is in a multi-traveler group. Personal lines are never attributed
   * (they're always the caller's). Off → group lines carry no author.
   */
  includeGroupAuthor: boolean;
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

/**
 * Body for `memories.patch(id, …)` — the **only** in-place mutate operation on a
 * memory. The live `PATCH /v1/memories/{id}` contract is group-membership
 * editing (verified against the deployed API; see gitban card 2syddu): you add
 * and/or remove a memory's group tags and get the full updated {@link Memory}
 * back. The old `{ text, metadata }` "UpdateRequest" the spec once documented is
 * **gone** — content corrections flow through ingest/supersede, not PATCH.
 *
 * At least one of the two arrays must carry an entry; an empty patch is rejected
 * client-side (and would be a `422 empty_patch` server-side). An empty array is
 * treated the same as an absent field and is not sent on the wire.
 */
export interface MemoryPatchRequest {
  /** Group ids to add to the memory's membership. */
  add_group_ids?: string[];
  /** Group ids to remove from the memory's membership. */
  remove_group_ids?: string[];
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
