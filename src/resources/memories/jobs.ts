// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Jobs extends APIResource {
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
   * const job = await client.memories.jobs.retrieve('job_id');
   * ```
   */
  retrieve(jobID: string, options?: RequestOptions): APIPromise<JobRetrieveResponse> {
    return this._client.get(path`/v1/memories/jobs/${jobID}`, options);
  }
}

/**
 * Returned by `POST /v1/memories` (with status 202 by default, 200 when
 * `?wait=true` succeeds inline) and by `GET /v1/memories/jobs/{job_id}`. Same wire
 * shape across every read of a job's lifecycle.
 */
export interface JobRetrieveResponse {
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
   * Job-level error payload. Mirrors the global error envelope shape so clients can
   * branch on `code` the same way they do for direct request failures.
   */
  error?: JobRetrieveResponse.Error | null;

  /**
   * Constant discriminator for the resource type.
   */
  object?: 'ingest_job';

  /**
   * Terminal job `result` payload, populated when status is `succeeded`.
   * `memories_created` and `memories_updated` carry thin :class:`MemoryRef` entries
   * rather than full `Memory` rows — see :class:`MemoryRef` for the trade-off
   * rationale and how to fetch the full row when needed.
   */
  result?: JobRetrieveResponse.Result | null;

  /**
   * ISO-8601 timestamp of the most recent state transition.
   */
  updated_at?: string | null;
}

export namespace JobRetrieveResponse {
  /**
   * Job-level error payload. Mirrors the global error envelope shape so clients can
   * branch on `code` the same way they do for direct request failures.
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
   * Terminal job `result` payload, populated when status is `succeeded`.
   * `memories_created` and `memories_updated` carry thin :class:`MemoryRef` entries
   * rather than full `Memory` rows — see :class:`MemoryRef` for the trade-off
   * rationale and how to fetch the full row when needed.
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

export declare namespace Jobs {
  export { type JobRetrieveResponse as JobRetrieveResponse };
}
