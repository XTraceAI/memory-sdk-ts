// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Memories extends APIResource {
  /**
   * Async ingest. Returns `202 + job_id` by default.
   *
   * With `?wait=true` the server holds the connection up to
   * `Settings.MEMORY_INGEST_WAIT_TIMEOUT_SECONDS` (30s default). If extraction
   * completes within that window, the response is `200 OK` with the terminal job
   * inline. If the deadline elapses first, the response falls back to `202 Accepted`
   * with `status: "pending"` and the caller resumes the polling pattern against
   * `GET /v1/memories/jobs/{job_id}`.
   *
   * The extraction task is spawned via `asyncio.create_task` and awaited via
   * `asyncio.wait(timeout=…, return_when=FIRST_COMPLETED)` — `wait` doesn't cancel
   * pending tasks on timeout, so the background extraction continues regardless of
   * whether the wait window elapsed. Strong reference held in :data:`_pending_jobs`
   * keeps the task from being garbage-collected.
   *
   * @example
   * ```ts
   * const memory = await client.memories.create({
   *   conv_id: 'conv-2026-05-15-abc',
   *   messages: [
   *     {
   *       content: 'I like Thai food and spicy dishes.',
   *       role: 'user',
   *     },
   *   ],
   *   user_id: 'alice',
   * });
   * ```
   */
  create(params: MemoryCreateParams, options?: RequestOptions): APIPromise<MemoryCreateResponse> {
    const { wait, ...body } = params;
    return this._client.post('/v1/memories', { query: { wait }, body, ...options });
  }

  /**
   * List memories with flat-equality filters and cursor pagination.
   *
   * @example
   * ```ts
   * const memories = await client.memories.list();
   * ```
   */
  list(
    query: MemoryListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<MemoryListResponse> {
    return this._client.get('/v1/memories', { query, ...options });
  }

  /**
   * Return the current state of an ingest job.
   *
   * Terminal states (`succeeded` / `failed`) are persisted in DynamoDB and remain
   * queryable indefinitely under the current deployment (the shared usage table has
   * no table-level TTL enabled). `result.memories_created` and
   * `result.memories_updated` carry thin :class:`MemoryRef` entries
   * (`{id, type, text}`) — fetch `GET /v1/memories/{id}` for the full `Memory`
   * shape. `404 job_not_found` still fires for unknown ids and for ids that exist
   * under a different org.
   *
   * @example
   * ```ts
   * const response = await client.memories.getJobStatus(
   *   'job_id',
   * );
   * ```
   */
  getJobStatus(jobID: string, options?: RequestOptions): APIPromise<MemoryGetJobStatusResponse> {
    return this._client.get(path`/v1/memories/jobs/${jobID}`, options);
  }

  /**
   * Vector + filter search over the unified memory pool.
   *
   * PR 4: org-wide vector search with cross-entity filtering. No partition lookup,
   * no precedence-based store routing — Qdrant's indexed-payload intersection drives
   * the candidate set, vector similarity ranks within it. Filters are the standard
   * DSL (per-field exact equality, `$in`/`$ne`/`$exists`/`$gte`/ `$lte`,
   * `AND`/`OR`/`NOT`); `type` (or `type: {$in: [...]}`) restricts which kb_types
   * participate. Default = all three (mixed-type results merged by raw cosine).
   *
   * `include` opts into composed output:
   *
   * - `"full_content"` — populate `details.full_content` on artifact rows (no-op for
   *   facts/episodes).
   * - `"context_prompt"` — run xmem's retrieval-agent pipeline; assembled markdown
   *   lands under `extras.context_prompt`, latency breakdown under
   *   `extras.stage_timings`. The agent pipeline is conv-scoped, so this path
   *   requires `conv_id` in `filters`.
   *
   * @example
   * ```ts
   * const response = await client.memories.search({
   *   query: 'who likes thai food?',
   * });
   * ```
   */
  search(body: MemorySearchParams, options?: RequestOptions): APIPromise<MemorySearchResponse> {
    return this._client.post('/v1/memories/search', { body, ...options });
  }
}

/**
 * Unified memory resource — facts, artifacts, episodes marshal to this shape.
 * `type` is the discriminator; `details` is the type-specific extension.
 *
 * The mem0-parity invariant: `text` is always a short readable preview, regardless
 * of type (fact statement / artifact summary / episode summary).
 */
export interface Memory {
  /**
   * Stable UUID for this memory row.
   */
  id: string;

  /**
   * Short readable preview. For facts: the claim statement. For artifacts: a summary
   * or title (full body lives in `details.full_content`, opt-in via
   * `include=full_content`). For episodes: a summary of the session.
   */
  text: string;

  /**
   * Memory subtype. `fact` = a single semantic claim extracted from a turn;
   * `artifact` = a structured object (code, doc, image) referenced by the
   * conversation; `episode` = a session-scoped summary of a stretch of turns.
   */
  type: 'fact' | 'artifact' | 'episode';

  /**
   * Agent scope, if any.
   */
  agent_id?: string | null;

  /**
   * App scope, if any.
   */
  app_id?: string | null;

  /**
   * Optional category labels from xmem's extraction pipeline.
   */
  categories?: Array<string>;

  /**
   * Conversation anchor.
   */
  conv_id?: string | null;

  /**
   * ISO-8601 timestamp of original ingest.
   */
  created_at?: unknown;

  /**
   * Type-specific extension. Shape depends on `type` — see `FactDetails` /
   * `ArtifactDetails` / `EpisodeDetails` schemas. Always an object; never null.
   */
  details?: Memory.FactDetails | Memory.ArtifactDetails | Memory.EpisodeDetails;

  /**
   * Free-form customer-supplied metadata that was on the row at write time. Each key
   * here is independently indexed and filterable on search.
   */
  metadata?: { [key: string]: unknown };

  /**
   * Constant discriminator for the resource type.
   */
  object?: 'memory';

  /**
   * Vector-similarity score. Present **only** on search responses; null on list /
   * get-by-id / patch / ingest result rows.
   */
  score?: number | null;

  /**
   * ISO-8601 timestamp of the last metadata patch / supersede.
   */
  updated_at?: unknown;

  /**
   * User scope this row belongs to.
   */
  user_id?: string | null;
}

export namespace Memory {
  /**
   * Per-row fact details — sits under `Memory.details` when `Memory.type == "fact"`.
   * Mirrors the SoT shape, not xmem's raw `Fact` shape: e.g. xmem's
   * `source_artifact_id` → `artifact_id`.
   */
  export interface FactDetails {
    artifact_id?: string | null;

    artifact_ids?: Array<string>;

    episode_id?: string | null;

    fact_type?: string | null;

    source_event_ids?: Array<string>;

    source_role?: string | null;

    status?: string | null;

    supersedes?: string | null;

    [k: string]: unknown;
  }

  /**
   * Per-row artifact details under `Memory.details` when
   * `Memory.type == "artifact"`.
   *
   * Wire-field renames vs xmem's `Artifact` schema:
   *
   * - `Artifact.name` → `details.title`
   * - `Artifact.descriptor_fact_ids` → `details.source_fact_ids`
   * - `Artifact.root_artifact_id` → `details.root_id`
   *
   * `full_content` is opt-in — omitted on list/search by default, included on
   * `GET /v1/memories/{id}` and when `include=["full_content"]` is set on
   * list/search.
   */
  export interface ArtifactDetails {
    episode_ids?: Array<string>;

    full_content?: string | null;

    rationale?: string | null;

    root_id?: string | null;

    source_fact_ids?: Array<string>;

    title?: string | null;

    version?: number | null;

    [k: string]: unknown;
  }

  /**
   * Per-row episode details under `Memory.details` when `Memory.type == "episode"`.
   */
  export interface EpisodeDetails {
    artifact_ids?: Array<string>;

    ended_at?: string | null;

    fact_ids?: Array<string>;

    started_at?: string | null;

    title?: string | null;

    [k: string]: unknown;
  }
}

/**
 * Returned by `POST /v1/memories` (with status 202 by default, 200 when
 * `?wait=true` succeeds inline) and by `GET /v1/memories/jobs/{job_id}`. Same wire
 * shape across every read of a job's lifecycle.
 */
export interface MemoryCreateResponse {
  /**
   * Opaque job id of the form `job_<32-hex-chars>`.
   */
  id: string;

  /**
   * ISO-8601 timestamp the job was created.
   */
  created_at: string;

  /**
   * Lifecycle state. `pending` → enqueued. `running` → extraction in progress.
   * `succeeded` → `result` is set. `failed` → `error` is set. Terminal jobs
   * (`succeeded` / `failed`) are retained for 24h before TTL sweep returns 404
   * `job_not_found`.
   */
  status: 'pending' | 'running' | 'succeeded' | 'failed';

  /**
   * Populated when `status = failed`; null otherwise.
   */
  error?: MemoryCreateResponse.Error | null;

  /**
   * Constant discriminator for the resource type.
   */
  object?: 'ingest_job';

  /**
   * Populated when `status = succeeded`; null otherwise.
   */
  result?: MemoryCreateResponse.Result | null;

  /**
   * ISO-8601 timestamp of the most recent state transition.
   */
  updated_at?: unknown;
}

export namespace MemoryCreateResponse {
  /**
   * Populated when `status = failed`; null otherwise.
   */
  export interface Error {
    /**
     * Stable error code; switch on this rather than the message. Typically
     * `ingest_failed`.
     */
    code: string;

    /**
     * Human-readable, sanitized summary. Safe to log; not safe to switch on.
     */
    message: string;

    /**
     * Error class — typically `"server_error"` for ingest failures.
     */
    type: string;
  }

  /**
   * Populated when `status = succeeded`; null otherwise.
   */
  export interface Result {
    /**
     * Thin references to new facts / episodes / artifacts written this ingest. Each
     * entry is `{id, type, text}`; full row shape is at `GET /v1/memories/{id}`.
     */
    memories_created?: Array<Result.MemoriesCreated>;

    /**
     * Map of `old_fact_id → new_fact_id`. Populated when the extraction pipeline
     * detects a contradiction with an existing active fact: the old fact's `tag2`
     * flips to superseded and the new fact records `supersedes = old_id`.
     */
    memories_superseded_by?: { [key: string]: string };

    /**
     * Thin references to existing rows whose payload was updated during this ingest
     * (e.g. artifact dedup hits).
     */
    memories_updated?: Array<Result.MemoriesUpdated>;

    /**
     * Constant discriminator for the resource type.
     */
    object?: 'ingest_result';

    /**
     * Per-stage extraction latencies (seconds).
     */
    stage_timings?: { [key: string]: number };
  }

  export namespace Result {
    /**
     * Thin reference to a memory row written or updated by an ingest job. Carries only
     * what a client needs for confirmation / per-type routing; the full `Memory` shape
     * (entity ids, metadata, details, timestamps, categories) is one
     * `GET /v1/memories/{id}` away.
     *
     * Trade-off rationale: storing the full `Memory` shape inside the DDB job row
     * duplicates content that already lives in Qdrant — every field except `id` is
     * derivable via the read endpoints. The thin shape keeps the row small while
     * preserving the two fields that make a poll response useful on its own: `type`
     * (lets clients route per memory subtype without a follow-up) and `text` (the
     * human-readable preview, makes the result usable as a confirmation receipt).
     */
    export interface MemoriesCreated {
      /**
       * Stable UUID of the written / updated row.
       */
      id: string;

      /**
       * Short readable preview as captured at write time. Same value as `Memory.text` on
       * the row at the moment of ingest. **Snapshot, not live state** — a subsequent
       * supersede (text PATCH) replaces the row's current text; the value here keeps
       * reflecting what the ingest job wrote. Fetch `GET /v1/memories/{id}` for current
       * state.
       */
      text: string;

      /**
       * Memory subtype. Determines which detail variant lives behind the id when fetched
       * via `GET /v1/memories/{id}`.
       */
      type: 'fact' | 'artifact' | 'episode';
    }

    /**
     * Thin reference to a memory row written or updated by an ingest job. Carries only
     * what a client needs for confirmation / per-type routing; the full `Memory` shape
     * (entity ids, metadata, details, timestamps, categories) is one
     * `GET /v1/memories/{id}` away.
     *
     * Trade-off rationale: storing the full `Memory` shape inside the DDB job row
     * duplicates content that already lives in Qdrant — every field except `id` is
     * derivable via the read endpoints. The thin shape keeps the row small while
     * preserving the two fields that make a poll response useful on its own: `type`
     * (lets clients route per memory subtype without a follow-up) and `text` (the
     * human-readable preview, makes the result usable as a confirmation receipt).
     */
    export interface MemoriesUpdated {
      /**
       * Stable UUID of the written / updated row.
       */
      id: string;

      /**
       * Short readable preview as captured at write time. Same value as `Memory.text` on
       * the row at the moment of ingest. **Snapshot, not live state** — a subsequent
       * supersede (text PATCH) replaces the row's current text; the value here keeps
       * reflecting what the ingest job wrote. Fetch `GET /v1/memories/{id}` for current
       * state.
       */
      text: string;

      /**
       * Memory subtype. Determines which detail variant lives behind the id when fetched
       * via `GET /v1/memories/{id}`.
       */
      type: 'fact' | 'artifact' | 'episode';
    }
  }
}

/**
 * Stripe-style list envelope used by `GET /v1/memories`,
 * `GET /v1/memories/{id}/revisions`, and the default search response.
 */
export interface MemoryListResponse {
  /**
   * Page of memory rows.
   */
  data?: Array<Memory>;

  /**
   * True if more rows exist beyond this page; use `next_cursor` to fetch them.
   */
  has_more?: boolean;

  /**
   * Opaque cursor for the next page. Null on the final page. Tenant-scoped: only
   * usable with the same `(org, key)` that produced it.
   */
  next_cursor?: string | null;

  /**
   * Constant discriminator for the resource type.
   */
  object?: 'list';
}

/**
 * Returned by `POST /v1/memories` (with status 202 by default, 200 when
 * `?wait=true` succeeds inline) and by `GET /v1/memories/jobs/{job_id}`. Same wire
 * shape across every read of a job's lifecycle.
 */
export interface MemoryGetJobStatusResponse {
  /**
   * Opaque job id of the form `job_<32-hex-chars>`.
   */
  id: string;

  /**
   * ISO-8601 timestamp the job was created.
   */
  created_at: string;

  /**
   * Lifecycle state. `pending` → enqueued. `running` → extraction in progress.
   * `succeeded` → `result` is set. `failed` → `error` is set. Terminal jobs
   * (`succeeded` / `failed`) are retained for 24h before TTL sweep returns 404
   * `job_not_found`.
   */
  status: 'pending' | 'running' | 'succeeded' | 'failed';

  /**
   * Populated when `status = failed`; null otherwise.
   */
  error?: MemoryGetJobStatusResponse.Error | null;

  /**
   * Constant discriminator for the resource type.
   */
  object?: 'ingest_job';

  /**
   * Populated when `status = succeeded`; null otherwise.
   */
  result?: MemoryGetJobStatusResponse.Result | null;

  /**
   * ISO-8601 timestamp of the most recent state transition.
   */
  updated_at?: unknown;
}

export namespace MemoryGetJobStatusResponse {
  /**
   * Populated when `status = failed`; null otherwise.
   */
  export interface Error {
    /**
     * Stable error code; switch on this rather than the message. Typically
     * `ingest_failed`.
     */
    code: string;

    /**
     * Human-readable, sanitized summary. Safe to log; not safe to switch on.
     */
    message: string;

    /**
     * Error class — typically `"server_error"` for ingest failures.
     */
    type: string;
  }

  /**
   * Populated when `status = succeeded`; null otherwise.
   */
  export interface Result {
    /**
     * Thin references to new facts / episodes / artifacts written this ingest. Each
     * entry is `{id, type, text}`; full row shape is at `GET /v1/memories/{id}`.
     */
    memories_created?: Array<Result.MemoriesCreated>;

    /**
     * Map of `old_fact_id → new_fact_id`. Populated when the extraction pipeline
     * detects a contradiction with an existing active fact: the old fact's `tag2`
     * flips to superseded and the new fact records `supersedes = old_id`.
     */
    memories_superseded_by?: { [key: string]: string };

    /**
     * Thin references to existing rows whose payload was updated during this ingest
     * (e.g. artifact dedup hits).
     */
    memories_updated?: Array<Result.MemoriesUpdated>;

    /**
     * Constant discriminator for the resource type.
     */
    object?: 'ingest_result';

    /**
     * Per-stage extraction latencies (seconds).
     */
    stage_timings?: { [key: string]: number };
  }

  export namespace Result {
    /**
     * Thin reference to a memory row written or updated by an ingest job. Carries only
     * what a client needs for confirmation / per-type routing; the full `Memory` shape
     * (entity ids, metadata, details, timestamps, categories) is one
     * `GET /v1/memories/{id}` away.
     *
     * Trade-off rationale: storing the full `Memory` shape inside the DDB job row
     * duplicates content that already lives in Qdrant — every field except `id` is
     * derivable via the read endpoints. The thin shape keeps the row small while
     * preserving the two fields that make a poll response useful on its own: `type`
     * (lets clients route per memory subtype without a follow-up) and `text` (the
     * human-readable preview, makes the result usable as a confirmation receipt).
     */
    export interface MemoriesCreated {
      /**
       * Stable UUID of the written / updated row.
       */
      id: string;

      /**
       * Short readable preview as captured at write time. Same value as `Memory.text` on
       * the row at the moment of ingest. **Snapshot, not live state** — a subsequent
       * supersede (text PATCH) replaces the row's current text; the value here keeps
       * reflecting what the ingest job wrote. Fetch `GET /v1/memories/{id}` for current
       * state.
       */
      text: string;

      /**
       * Memory subtype. Determines which detail variant lives behind the id when fetched
       * via `GET /v1/memories/{id}`.
       */
      type: 'fact' | 'artifact' | 'episode';
    }

    /**
     * Thin reference to a memory row written or updated by an ingest job. Carries only
     * what a client needs for confirmation / per-type routing; the full `Memory` shape
     * (entity ids, metadata, details, timestamps, categories) is one
     * `GET /v1/memories/{id}` away.
     *
     * Trade-off rationale: storing the full `Memory` shape inside the DDB job row
     * duplicates content that already lives in Qdrant — every field except `id` is
     * derivable via the read endpoints. The thin shape keeps the row small while
     * preserving the two fields that make a poll response useful on its own: `type`
     * (lets clients route per memory subtype without a follow-up) and `text` (the
     * human-readable preview, makes the result usable as a confirmation receipt).
     */
    export interface MemoriesUpdated {
      /**
       * Stable UUID of the written / updated row.
       */
      id: string;

      /**
       * Short readable preview as captured at write time. Same value as `Memory.text` on
       * the row at the moment of ingest. **Snapshot, not live state** — a subsequent
       * supersede (text PATCH) replaces the row's current text; the value here keeps
       * reflecting what the ingest job wrote. Fetch `GET /v1/memories/{id}` for current
       * state.
       */
      text: string;

      /**
       * Memory subtype. Determines which detail variant lives behind the id when fetched
       * via `GET /v1/memories/{id}`.
       */
      type: 'fact' | 'artifact' | 'episode';
    }
  }
}

/**
 * Search response — list envelope + optional `extras` block.
 */
export interface MemorySearchResponse {
  /**
   * Ranked rows. Mixed kb_types are merged by raw cosine; `score` carries the
   * similarity value.
   */
  data?: Array<Memory>;

  /**
   * Populated only when `include` opts in. `null` on a default search response.
   */
  extras?: MemorySearchResponse.Extras | null;

  has_more?: boolean;

  next_cursor?: string | null;

  /**
   * Constant discriminator for the resource type.
   */
  object?: 'list';
}

export namespace MemorySearchResponse {
  /**
   * Populated only when `include` opts in. `null` on a default search response.
   */
  export interface Extras {
    /**
     * Assembled markdown context block from xmem's retrieval agent. Populated only
     * when `include` contained `context_prompt`; null otherwise.
     */
    context_prompt?: string | null;

    /**
     * Per-stage retrieval-pipeline latencies (seconds).
     */
    stage_timings?: { [key: string]: number };
  }
}

export interface MemoryCreateParams {
  /**
   * Body param: Conversation identifier. REQUIRED. Anchors every extracted memory to
   * a conversation for replay, export, and bulk retract.
   */
  conv_id: string;

  /**
   * Body param: Chat-style turns to extract memories from. Must be non-empty — an
   * empty list returns 400 `invalid_messages` (the route raises this explicitly so
   * the wire error carries the stable code rather than a generic Pydantic validation
   * message). Server picks live vs batch extraction by length; no client-facing
   * strategy hint.
   */
  messages: Array<MemoryCreateParams.Message>;

  /**
   * Body param: User identifier. REQUIRED. Keys the per-user session namespace so a
   * user's facts accumulate across their conversations rather than fragmenting
   * per-conv. Also stored as an indexed filter axis on every row.
   */
  user_id: string;

  /**
   * Query param: When true, hold the connection up to ~30s waiting for extraction to
   * terminate. Returns 200 + terminal job inline on success; falls back to 202 +
   * `pending` on timeout. Default false → 202 + pending immediately.
   */
  wait?: boolean;

  /**
   * Body param: Optional agent scope. Indexed alongside the other entity ids.
   */
  agent_id?: string | null;

  /**
   * Body param: Optional app scope. Indexed alongside the other entity ids.
   */
  app_id?: string | null;

  /**
   * Body param: When true, run the artifact-extraction stage in addition to fact +
   * episode extraction. Off by default — most expensive stage and most callers don't
   * need it. Setting this routes the request through the batch extraction path
   * regardless of message count.
   */
  extract_artifacts?: boolean;

  /**
   * Body param: Free-form customer metadata. Each key lands as its own indexed
   * payload key, filterable on search. Reserved internal keys (`tag1`-`tag5`,
   * `kb_type`, `org_id`, etc.) are stripped silently — see the `reserved_field`
   * PATCH error for the list.
   */
  metadata?: { [key: string]: unknown } | null;
}

export namespace MemoryCreateParams {
  /**
   * One chat-style turn in an ingest payload. Order matters: facts and episodes are
   * extracted by walking adjacent user→assistant pairs (the live path) or the full
   * sequence (the batch path).
   */
  export interface Message {
    /**
     * Message text content.
     */
    content: string;

    /**
     * Speaker role: typically `"user"` or `"assistant"`.
     */
    role: string;

    /**
     * Optional ISO-8601 timestamp for the turn. Used by the batch ingest path when
     * provided; ignored by the live path.
     */
    date?: unknown;

    /**
     * Optional client-supplied per-turn id (carried for trace/eval pipelines).
     */
    dia_id?: string | null;
  }
}

export interface MemoryListParams {
  /**
   * Filter by agent_id (exact match).
   */
  agent_id?: string | null;

  /**
   * Filter by app_id (exact match).
   */
  app_id?: string | null;

  /**
   * Filter by conv_id (exact match).
   */
  conv_id?: string | null;

  /**
   * Opaque pagination cursor from a previous response's `next_cursor`. Must match
   * this request's `order` and the issuing org (mismatch → 422 `cursor_mismatch`).
   */
  cursor?: string | null;

  /**
   * Comma-separated opt-in extras. Currently only `full_content` is supported
   * (populates `details.full_content` on artifact rows).
   */
  include?: string | null;

  /**
   * Maximum rows per page. 1–100, default 50.
   */
  limit?: number;

  /**
   * Sort order on `(created_at, id)`.
   */
  order?: 'created_at_desc' | 'created_at_asc';

  /**
   * Restrict results to one memory subtype. Default: all three.
   */
  type?: 'fact' | 'artifact' | 'episode' | null;

  /**
   * Filter by user_id (exact match). Combine with other entity params for AND.
   */
  user_id?: string | null;
}

export interface MemorySearchParams {
  /**
   * Natural-language query text. Embedded server-side; cosine-similarity-ranked.
   */
  query: string;

  /**
   * Opaque pagination cursor from a previous response's `next_cursor`. Tenant-scoped
   * — using one from another org returns 422 `cursor_mismatch`.
   */
  cursor?: string | null;

  /**
   * Filter DSL. Top-level keys are implicit-AND. Supported operators on per-field
   * values: bare value, `null`, `$eq`, `$ne`, `$in`, `$nin`, `$exists`,
   * `$gt`/`$gte`/`$lt`/`$lte`, `$between`. Boolean composition: `AND` / `OR` /
   * `NOT`. `type` (string or `$in` list) restricts which kb_types are scanned
   * (default = all three).
   */
  filters?: { [key: string]: unknown };

  /**
   * Opt-in extras. `full_content` populates `details.full_content` on artifact rows
   * (no-op for facts/episodes). `context_prompt` runs xmem's retrieval-agent
   * pipeline; the assembled markdown lands under `extras.context_prompt` and
   * requires both `user_id` and `conv_id` in `filters`.
   */
  include?: Array<'full_content' | 'context_prompt'>;

  /**
   * Maximum rows to return. 1–100, default 20.
   */
  limit?: number;
}

export declare namespace Memories {
  export {
    type Memory as Memory,
    type MemoryCreateResponse as MemoryCreateResponse,
    type MemoryListResponse as MemoryListResponse,
    type MemoryGetJobStatusResponse as MemoryGetJobStatusResponse,
    type MemorySearchResponse as MemorySearchResponse,
    type MemoryCreateParams as MemoryCreateParams,
    type MemoryListParams as MemoryListParams,
    type MemorySearchParams as MemorySearchParams,
  };
}
