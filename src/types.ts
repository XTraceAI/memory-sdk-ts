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
  metadata: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
  /** Run the artifact-extraction stage. Defaults to `true` in the SDK; pass `false` to skip it. */
  extract_artifacts?: boolean;
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

export interface SearchRequest {
  query: string;
  filters?: Filter;
  limit?: number;
  cursor?: string | null;
  include?: Array<"context_prompt" | "full_content">;
}

export interface UpdateRequest {
  text?: string;
  metadata?: Record<string, unknown>;
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
