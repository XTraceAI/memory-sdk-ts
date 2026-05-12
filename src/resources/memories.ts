// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import * as MemoriesAPI from './memories';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Memories extends APIResource {
  /**
   * Get one memory by id. Scope resolved from the row itself.
   */
  retrieve(memoryID: string, options?: RequestOptions): APIPromise<Mem0Memory> {
    return this._client.get(path`/v1/memories/${memoryID}/`, {
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }

  /**
   * Update memory text — supersedes old + creates new.
   */
  update(memoryID: string, body: MemoryUpdateParams, options?: RequestOptions): APIPromise<Mem0Memory> {
    return this._client.patch(path`/v1/memories/${memoryID}/`, {
      body,
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }

  /**
   * List active memories matching `filters`. Paginated.
   *
   * `filters` carries the same shape as `/search/`: at least one entity id; optional
   * workspace_id / cb_id / OR clauses.
   */
  list(params: MemoryListParams, options?: RequestOptions): APIPromise<MemoryListResponse> {
    const { page, page_size, ...body } = params;
    return this._client.post('/v1/memories/', {
      query: { page, page_size },
      body,
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }

  /**
   * Delete Memory
   */
  delete(memoryID: string, options?: RequestOptions): APIPromise<unknown> {
    return this._client.delete(path`/v1/memories/${memoryID}/`, {
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }

  /**
   * Ingest memories. `mode=chat` pairs messages; `mode=import` is bulk.
   *
   * Workspace/CB write target lives in `metadata.workspace_id` / `metadata.cb_id`
   * (absent → hosted single-tenant write).
   */
  add(body: MemoryAddParams, options?: RequestOptions): APIPromise<MemoryAddResponse> {
    return this._client.post('/v1/memories/add/', {
      body,
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }

  /**
   * Search memories. `mode=flat` returns a flat list; `mode=context` runs the full
   * retrieval agent and returns assembled context.
   */
  search(body: MemorySearchParams, options?: RequestOptions): APIPromise<MemorySearchResponse> {
    return this._client.post('/v1/memories/search/', {
      body,
      ...options,
      __security: { apiKeyHeaderAuth: true, orgIDAuth: true, bearerTokenAuth: true },
    });
  }
}

export interface Artifact {
  artifact_id: string;

  artifact_type?: string | null;

  content?: string | null;

  conv_id?: string | null;

  created_at?: string | null;

  descriptor_fact_ids?: Array<string>;

  episode_id?: string | null;

  is_latest?: boolean | null;

  name?: string | null;

  parent_artifact_id?: string | null;

  rationale?: string | null;

  root_artifact_id?: string | null;

  score?: number | null;

  summary?: string | null;

  version?: number | null;
}

export interface Episode {
  episode_id: string;

  artifact_ids?: Array<string>;

  conv_id?: string | null;

  ended_at?: string | null;

  fact_ids?: Array<string>;

  started_at?: string | null;

  summary?: string | null;

  title?: string | null;
}

export interface Fact {
  fact_id: string;

  text: string;

  change_reason?: string | null;

  change_type?: string | null;

  consolidated_at?: string | null;

  conv_id?: string | null;

  created_at?: string | null;

  episode_id?: string | null;

  event_date?: string | null;

  fact_type?: string | null;

  metadata?: { [key: string]: unknown };

  origin?: string | null;

  root_artifact_id?: string | null;

  score?: number | null;

  source_artifact_id?: string | null;

  source_dia_ids?: Array<string>;

  source_event_ids?: Array<string>;

  source_role?: string | null;

  status?: string | null;

  supersedes?: string | null;
}

/**
 * One result item in mem0's response envelope.
 */
export interface Mem0Memory {
  id: string;

  memory: string;

  agent_id?: string | null;

  app_id?: string | null;

  categories?: Array<string>;

  created_at?: string | null;

  metadata?: { [key: string]: unknown };

  run_id?: string | null;

  score?: number | null;

  updated_at?: string | null;

  user_id?: string | null;
}

/**
 * mem0's paginated envelope.
 */
export interface MemoryListResponse {
  count: number;

  next?: string | null;

  previous?: string | null;

  results?: Array<Mem0Memory>;
}

export type MemoryDeleteResponse = unknown;

/**
 * Returned by POST /v1/memories/add/.
 *
 * Carries mem0's envelope (`event_id`, `status`, `message`) and our richer
 * xmem-DTO fields (`stored_facts`, `stored_artifacts`, `flush_result`, etc.)
 * alongside. mem0 SDKs that only read the envelope work unchanged; clients that
 * want episode ids / belief- revision events read the extra fields.
 */
export interface MemoryAddResponse {
  event_id: string;

  consolidation_id_mapping?: { [key: string]: string };

  /**
   * Serialized xmem `FlushResult` — episode ids produced when auto-flush (chat mode)
   * or `flush_after` (import mode) fires.
   */
  flush_result?: MemoryAddResponse.FlushResult | null;

  message?: string;

  mode?: 'chat' | 'import';

  stage_timings?: { [key: string]: number };

  status?: string;

  stored_artifacts?: Array<Artifact>;

  stored_facts?: Array<Fact>;

  superseded_fact_ids?: Array<Array<unknown>>;
}

export namespace MemoryAddResponse {
  /**
   * Serialized xmem `FlushResult` — episode ids produced when auto-flush (chat mode)
   * or `flush_after` (import mode) fires.
   */
  export interface FlushResult {
    episodes?: Array<MemoriesAPI.Episode>;

    stage_timings?: { [key: string]: number };
  }
}

/**
 * Returned by POST /v1/memories/search/.
 *
 * Mem0's flat `results` is always populated. In `mode=context` the additional
 * fields (`context`, `artifacts`, `episodes`) are filled in alongside.
 */
export interface MemorySearchResponse {
  all_retrieved_artifacts?: Array<Artifact>;

  artifacts?: Array<Artifact>;

  context?: string;

  episodes?: Array<Episode>;

  facts?: Array<Fact>;

  mode?: 'flat' | 'context';

  results?: Array<Mem0Memory>;

  stage_timings?: { [key: string]: number };
}

export interface MemoryUpdateParams {
  metadata?: { [key: string]: unknown } | null;

  text?: string | null;
}

export interface MemoryListParams {
  /**
   * Body param
   */
  filters: { [key: string]: unknown };

  /**
   * Query param
   */
  page?: number;

  /**
   * Query param
   */
  page_size?: number;
}

export interface MemoryAddParams {
  messages: Array<MemoryAddParams.Message>;

  agent_id?: string | null;

  app_id?: string | null;

  config_overrides?: { [key: string]: unknown } | null;

  custom_instructions?: string | null;

  flush_after?: boolean;

  flush_hint?: 'force' | null;

  infer?: boolean;

  metadata?: { [key: string]: unknown } | null;

  mode?: 'chat' | 'import';

  run_id?: string | null;

  user_id?: string | null;
}

export namespace MemoryAddParams {
  export interface Message {
    content: string;

    role: string;

    date?: string | null;

    dia_id?: string | null;
  }
}

export interface MemorySearchParams {
  filters: { [key: string]: unknown };

  query: string;

  char_budget?: number | null;

  conv_id?: string | null;

  conversation_history?: Array<{ [key: string]: unknown }> | null;

  exclude_artifact_ids?: Array<string> | null;

  mode?: 'flat' | 'context';

  rerank?: boolean;

  threshold?: number;

  top_k?: number;
}

export declare namespace Memories {
  export {
    type Artifact as Artifact,
    type Episode as Episode,
    type Fact as Fact,
    type Mem0Memory as Mem0Memory,
    type MemoryListResponse as MemoryListResponse,
    type MemoryDeleteResponse as MemoryDeleteResponse,
    type MemoryAddResponse as MemoryAddResponse,
    type MemorySearchResponse as MemorySearchResponse,
    type MemoryUpdateParams as MemoryUpdateParams,
    type MemoryListParams as MemoryListParams,
    type MemoryAddParams as MemoryAddParams,
    type MemorySearchParams as MemorySearchParams,
  };
}
