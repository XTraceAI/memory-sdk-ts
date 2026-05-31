import type { HttpClient } from "./http.js";
import { Jobs } from "./jobs.js";
import type {
  IngestJob,
  IngestRequest,
  ListEnvelope,
  ListQuery,
  Memory,
  RecallParams,
  RecallResult,
  RecallScopeStat,
  SearchListEnvelope,
  SearchRequest,
} from "./types.js";

/**
 * Render memories into a single, ready-to-inject context block — deterministic,
 * no LLM, no wasted tokens. Group-tagged ("shared") and personal memories are
 * split into labeled sections when both are present (a flat list otherwise);
 * each bullet carries the memory's categories and recorded date when available.
 * Pass your own renderer to `recall(..., { render })` for a different shape.
 */
export function renderMemoriesPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const line = (m: Memory): string => {
    let s = `- ${m.text}`;
    if (m.categories && m.categories.length > 0) s += ` [${m.categories.join(", ")}]`;
    const recorded = m.created_at ? m.created_at.slice(0, 10) : ""; // YYYY-MM-DD
    if (recorded) s += ` (recorded ${recorded})`;
    return s;
  };

  const header = "Relevant memories about the user:";
  const shared = memories.filter((m) => m.group_ids && m.group_ids.length > 0);
  const personal = memories.filter((m) => !m.group_ids || m.group_ids.length === 0);

  // Only one kind present → a flat list reads cleaner than a lone section.
  if (shared.length === 0 || personal.length === 0) {
    return `${header}\n${memories.map(line).join("\n")}`;
  }

  return [
    header,
    `Personal:\n${personal.map(line).join("\n")}`,
    `Shared (group):\n${shared.map(line).join("\n")}`,
  ].join("\n\n");
}

export interface IngestOptions {
  /**
   * If true, hold the connection up to 30s server-side and return the full
   * result inline when extraction completes. Falls back to async (202 +
   * job_id) if the budget elapses.
   */
  wait?: boolean;
  signal?: AbortSignal;
  requestId?: string;
}

export interface RequestContext {
  signal?: AbortSignal;
  requestId?: string;
}

export class Memories {
  readonly jobs: Jobs;

  constructor(private readonly http: HttpClient) {
    this.jobs = new Jobs(http);
  }

  /**
   * Ingest one or more messages. Always returns an `IngestJob`.
   *
   * - Default (async): `status` is `pending` / `processing`; call
   *   `client.memories.jobs.pollUntilDone(job.id)` to await completion.
   * - `{ wait: true }`: server tries to finish extraction inline (up to 30s).
   *   If it succeeded in time, `status` is already `succeeded` and `result`
   *   is populated. If the budget elapsed, falls back to async — same as the
   *   default path.
   */
  async ingest(body: IngestRequest, options: IngestOptions = {}): Promise<IngestJob> {
    const payload = { ...body, extract_artifacts: body.extract_artifacts ?? true };
    const { body: response } = await this.http.request<IngestJob>("POST", "/v1/memories", {
      body: payload,
      query: options.wait ? { wait: "true" } : undefined,
      signal: options.signal,
      requestId: options.requestId,
    });
    return response;
  }

  /** Fetch a single memory by id. Returns the full representation. */
  async get(id: string, context: RequestContext = {}): Promise<Memory> {
    const { body } = await this.http.request<Memory>("GET", `/v1/memories/${encodeURIComponent(id)}`, {
      signal: context.signal,
      requestId: context.requestId,
    });
    return body;
  }

  /**
   * Hard-delete a memory by id. The point is removed outright (no tombstone):
   * afterwards `get` returns 404, it's gone from list/search, and a second
   * delete returns 404 (idempotent by absence). Corrections flow through
   * ingest, not a PATCH — the memory API has no update endpoint.
   */
  async delete(id: string, context: RequestContext = {}): Promise<void> {
    await this.http.request<void>("DELETE", `/v1/memories/${encodeURIComponent(id)}`, {
      signal: context.signal,
      requestId: context.requestId,
    });
  }

  /** Vector + filter search. */
  async search(body: SearchRequest, context: RequestContext = {}): Promise<SearchListEnvelope> {
    const { body: response } = await this.http.request<SearchListEnvelope>("POST", "/v1/memories/search", {
      body,
      signal: context.signal,
      requestId: context.requestId,
    });
    return response;
  }

  /**
   * Sugar over {@link search} that forces `mode: "compose"` — the response's
   * `context` carries xmem's LLM-assembled, ready-to-inject prompt (and `data`
   * the agent-filtered rows). For a personal + shared (group) read in one call,
   * use {@link recall} instead.
   */
  async retrieve(body: SearchRequest, context: RequestContext = {}): Promise<SearchListEnvelope> {
    return this.search({ ...body, mode: "compose" }, context);
  }

  /**
   * Personal **+** shared (group) read in a single call.
   *
   * Search scoping is AND-everything ("scope by what you pass"), so a
   * combined "my own preferences AND the shared trip's facts" read can't be
   * expressed as one request — `{ user_id, group_ids }` would intersect, not
   * union. `recall` rebuilds that union client-side: it fans out one search
   * per scope you supply — `{ user_id }` for the caller's own memories and
   * `{ group_ids }` for the shared group(s) — in parallel, dedupes the rows
   * by id, re-ranks by score, and renders **one** ready-to-inject prompt.
   *
   * With the default `mode: "compose"`, each sub-search returns its
   * *agent-filtered* rows (the LLM context-selection pass runs per scope), so
   * the merged set is "the relevant personal facts + the relevant shared
   * facts" — deduped, and without the duplicated framing (or double prompt
   * cost) you'd get from concatenating two assembled `context` strings.
   *
   * At least one of `user_id` / `group_ids` must be supplied.
   *
   * @example
   * const { prompt, memories } = await client.memories.recall({
   *   query: "what should I plan for dinner on the trip?",
   *   user_id: "alice",            // her dietary prefs
   *   group_ids: ["grp_tokyo2026"] // the group's shared restaurant picks
   * });
   * // inject `prompt` into your agent's context
   */
  async recall(
    params: RecallParams,
    options: { render?: (memories: Memory[]) => string } & RequestContext = {},
  ): Promise<RecallResult> {
    const { query, user_id, group_ids, agent_id, app_id } = params;
    const mode = params.mode ?? "compose";
    const limit = params.limit ?? 10;
    const hasGroups = Array.isArray(group_ids) && group_ids.length > 0;
    if (!user_id && !hasGroups) {
      throw new Error("recall(): provide at least one of `user_id` or `group_ids`");
    }

    const base = { query, agent_id, app_id, mode, limit };
    const ctx: RequestContext = { signal: options.signal, requestId: options.requestId };

    const jobs: Array<{ scope: RecallScopeStat["scope"]; promise: Promise<SearchListEnvelope> }> = [];
    if (user_id) {
      jobs.push({ scope: "personal", promise: this.search({ ...base, user_id }, ctx) });
    }
    if (hasGroups) {
      jobs.push({ scope: "shared", promise: this.search({ ...base, group_ids }, ctx) });
    }

    const envelopes = await Promise.all(
      jobs.map(async (j) => ({ scope: j.scope, env: await j.promise })),
    );

    // Dedupe across scopes by id; when a memory matches more than one scope,
    // keep the higher-scored copy so the merged ranking stays meaningful.
    const byId = new Map<string, Memory>();
    const scopes: RecallScopeStat[] = [];
    for (const { scope, env } of envelopes) {
      const rows = env.data ?? [];
      scopes.push({ scope, count: rows.length });
      for (const m of rows) {
        const existing = byId.get(m.id);
        if (!existing || (m.score ?? -Infinity) > (existing.score ?? -Infinity)) {
          byId.set(m.id, m);
        }
      }
    }

    const memories = Array.from(byId.values())
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, limit);

    const render = options.render ?? renderMemoriesPrompt;
    return { memories, prompt: render(memories), scopes };
  }

  /**
   * Iterate every memory matching the query, auto-paginating until the
   * server says `has_more: false`.
   */
  async *list(query: ListQuery = {}, context: RequestContext = {}): AsyncGenerator<Memory, void, void> {
    let cursor = query.cursor;
    while (true) {
      const env = await this.listPage({ ...query, cursor }, context);
      for (const memory of env.data) yield memory;
      if (!env.has_more || !env.next_cursor) return;
      cursor = env.next_cursor;
    }
  }

  /** Single page of memories. Use when you need cursor-level control. */
  async listPage(query: ListQuery = {}, context: RequestContext = {}): Promise<ListEnvelope<Memory>> {
    const { body } = await this.http.request<ListEnvelope<Memory>>("GET", "/v1/memories", {
      query: {
        user_id: query.user_id,
        agent_id: query.agent_id,
        conv_id: query.conv_id,
        app_id: query.app_id,
        type: query.type,
        cursor: query.cursor,
        limit: query.limit,
        order: query.order,
        include: query.include?.join(","),
      },
      signal: context.signal,
      requestId: context.requestId,
    });
    return body;
  }
}
