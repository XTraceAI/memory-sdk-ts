import type { HttpClient } from "./http.js";
import { Jobs } from "./jobs.js";
import type {
  ActionContext,
  IngestJob,
  IngestRequest,
  GroupListEnvelope,
  LessonMemory,
  LessonProcedureType,
  ListEnvelope,
  ListQuery,
  Memory,
  ProcedureMemory,
  PromptTemplate,
  RecallParams,
  RecallResult,
  RecallScopeStat,
  ScopePool,
  SearchListEnvelope,
  SearchMode,
  SearchRequest,
  TriggerRequest,
  TriggerResponse,
} from "./types.js";

/**
 * The SDK's built-in prompt format. Phase 1 of the template plan: the format
 * lives here as data so it can be swapped wholesale. Phase 2: a future API
 * endpoint returns xmem's preferred {@link PromptTemplate}; the SDK fetches it
 * (cached) and passes it as `recall(..., { template })` with no render-engine
 * change.
 */
export const DEFAULT_PROMPT_TEMPLATE: PromptTemplate = {
  header: "Relevant memories about the user:",
  personalLabel: "Personal",
  unknownGroupLabel: "Shared group {id}",
  typeLabels: { fact: "", artifact: "[document] ", episode: "[conversation] " },
  includeCategories: true,
  includeRecordedDate: true,
  includeGroupAuthor: true,
};

/**
 * Render memories into a single, ready-to-inject context block — deterministic,
 * no LLM, no wasted tokens. Personal (untagged) memories and each group's
 * shared memories become labeled sections (a flat list when there are no
 * group-tagged rows); `opts.groupNames` maps a `group_id` to its section label
 * (falls back to the template's `unknownGroupLabel`). Formatting — header,
 * labels, per-type tags, whether categories/dates show — is driven by
 * `opts.template` (defaults to {@link DEFAULT_PROMPT_TEMPLATE}). Pass your own
 * renderer to `recall(..., { render })` to bypass this entirely.
 */
export function renderMemoriesPrompt(
  memories: Memory[],
  opts: {
    groupNames?: Record<string, string>;
    template?: PromptTemplate;
    viewerUserId?: string;
    /**
     * The group ids the caller actually requested. When set, only these groups
     * get their own section; a row tagged solely to OTHER groups (e.g. the
     * caller's own row from another trip, surfaced by the personal scope)
     * renders under Personal instead of leaking an unrequested group section.
     * When omitted, every group tag present gets a section (back-compat).
     */
    requestedGroupIds?: string[];
    /**
     * Per-row source labels for rows from a non-user, non-group pool (e.g. an
     * `app_id`/`agent_id` knowledge-base pool). Such rows render under their own
     * labeled section instead of the user's Personal section, so a KB doc isn't
     * framed as the user's own memory.
     */
    sourceLabels?: Record<string, string>;
  } = {},
): string {
  if (memories.length === 0) return "";
  const t = opts.template ?? DEFAULT_PROMPT_TEMPLATE;
  const groupNames = opts.groupNames ?? {};
  const requestedSet = opts.requestedGroupIds ? new Set(opts.requestedGroupIds) : null;
  // A row belongs in a group section iff it carries a tag we're sectioning on:
  // any requested group (when a request set is given), else any group at all.
  const isGroupRow = (m: Memory): boolean =>
    (m.group_ids ?? []).some((g) => (requestedSet ? requestedSet.has(g) : true));

  // Attribution rules:
  //  - In a group section, name the author so members can tell who said what:
  //    "you:" for the viewer (when known), the user id for everyone else.
  //  - Outside a group (Personal/flat), attribute only a NON-viewer row, and
  //    only when a viewer is actually known — so unioning multiple user pools
  //    never presents one user's facts as the viewer's, while a standalone render
  //    of a single user's memories (no viewerUserId) stays plain.
  const line = (m: Memory, inGroup: boolean, attribute = true): string => {
    let lead = m.text;
    // Facts render as plain statements; artifacts/episodes get a per-type tag
    // (from the template) + their title, so the agent can tell a document or a
    // past conversation from a stated fact.
    if ((m.type === "artifact" || m.type === "episode") && m.details.title) {
      lead = `${m.details.title}: ${m.text}`;
    }
    let author = "";
    if (attribute && t.includeGroupAuthor && m.user_id) {
      const isViewer = m.user_id === opts.viewerUserId;
      if (inGroup) author = isViewer ? "you: " : `${m.user_id}: `;
      else if (opts.viewerUserId !== undefined && !isViewer) author = `${m.user_id}: `;
    }
    let s = `- ${author}${t.typeLabels[m.type] ?? ""}${lead}`;
    if (t.includeCategories && m.categories && m.categories.length > 0) {
      s += ` [${m.categories.join(", ")}]`;
    }
    const recorded = t.includeRecordedDate && m.created_at ? m.created_at.slice(0, 10) : "";
    if (recorded) s += ` (recorded ${recorded})`;
    return s;
  };

  const sourceLabels = opts.sourceLabels ?? {};
  // A row from a non-user, non-group "source" pool (an app/agent knowledge base)
  // gets its own labeled section rather than being framed as the user's memory.
  // Group membership wins: a source row that's also tagged to a requested group
  // still renders under that group.
  const sourceLabelOf = (m: Memory): string | undefined =>
    isGroupRow(m) ? undefined : sourceLabels[m.id];

  const personal = memories.filter((m) => !isGroupRow(m) && !sourceLabelOf(m));
  const shared = memories.filter((m) => isGroupRow(m));
  const sourced = memories.filter((m) => sourceLabelOf(m) !== undefined);

  // Only personal rows → a flat list reads cleaner than a lone section.
  if (shared.length === 0 && sourced.length === 0) {
    return `${t.header}\n${memories.map((m) => line(m, false)).join("\n")}`;
  }

  // Bucket shared memories by group, in first-appearance order — but only under
  // groups we're sectioning on (the requested set, when given), so a row tagged
  // to extra groups doesn't spawn unrequested sections. Multi-tagged rows appear
  // under each of their sectioned groups (rare).
  const order: string[] = [];
  const byGroup = new Map<string, Memory[]>();
  for (const m of shared) {
    for (const gid of m.group_ids) {
      if (requestedSet && !requestedSet.has(gid)) continue;
      let bucket = byGroup.get(gid);
      if (!bucket) {
        bucket = [];
        byGroup.set(gid, bucket);
        order.push(gid);
      }
      bucket.push(m);
    }
  }

  // Bucket source rows by their label (e.g. an app_id KB), first-appearance order.
  const sourceOrder: string[] = [];
  const bySource = new Map<string, Memory[]>();
  for (const m of sourced) {
    const lbl = sourceLabelOf(m)!;
    let bucket = bySource.get(lbl);
    if (!bucket) {
      bucket = [];
      bySource.set(lbl, bucket);
      sourceOrder.push(lbl);
    }
    bucket.push(m);
  }

  const sections: string[] = [];
  if (personal.length > 0) {
    sections.push(`${t.personalLabel}:\n${personal.map((m) => line(m, false)).join("\n")}`);
  }
  for (const gid of order) {
    const label = groupNames[gid] || t.unknownGroupLabel.replace("{id}", gid);
    sections.push(`${label}:\n${byGroup.get(gid)!.map((m) => line(m, true)).join("\n")}`);
  }
  for (const lbl of sourceOrder) {
    // Source rows aren't author-attributed — the section header names the source.
    sections.push(`${lbl}:\n${bySource.get(lbl)!.map((m) => line(m, false, false)).join("\n")}`);
  }
  return [t.header, ...sections].join("\n\n");
}

/**
 * Render recalled `lesson` / `procedure` rows into a single inject-ready block —
 * deterministic, no LLM. Used for `mode: "retrieve"` (which returns no
 * server-assembled `context`) and as the default for `preToolHook`'s render
 * override. Under `compose`, prefer the server's `context` string, which is
 * assembled the same way with the gate's `because` rationale attached.
 */
export function renderLessonProcedurePrompt(
  rows: Array<LessonMemory | ProcedureMemory>,
): string {
  if (rows.length === 0) return "";
  const lines = ["Relevant lessons & procedures:"];
  for (const r of rows) {
    const tag = (r.details.fact_type ?? r.type).toUpperCase();
    const why = r.details.because;
    lines.push(`- **[${tag}]** ${r.text}${why ? ` — ${why}` : ""}`);
  }
  return lines.join("\n");
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

export interface PreToolHookOptions extends RequestContext {
  /** Scope — at least one axis required (validated client-side). */
  user_id?: string;
  group_ids?: string[];
  agent_id?: string;
  app_id?: string;
  /** Current goal; gates recalled insights under `compose`. */
  task?: string;
  /** Pipeline depth. Defaults to `"compose"` (relevance-gated + assembled block). */
  mode?: SearchMode;
  /** Restrict the corpora recalled. Defaults to both `lesson` + `procedure`. */
  include?: LessonProcedureType[];
  /**
   * Hard client-side timeout in ms. Opt-in: the server already bounds recall to
   * ~5s and fails soft, so leave this unset unless you need a tighter cap. A
   * value below the server budget can clip a normal `compose` call.
   */
  timeoutMs?: number;
  /** Override the `retrieve`-mode block renderer (unused under `compose`). */
  render?: (rows: Array<LessonMemory | ProcedureMemory>) => string;
}

export interface PreToolHookResult {
  /**
   * Inject-ready block. The server's assembled `context` under `compose`; the
   * client-rendered block under `retrieve`. Empty string when nothing matched
   * or the call degraded.
   */
  context: string;
  /** The raw matched `lesson` / `procedure` rows. */
  memories: Array<LessonMemory | ProcedureMemory>;
  /** True when the call failed soft (network error / timeout) and returned empty. */
  degraded: boolean;
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
   * Procedural-memory recall for a pre-tool-call hook (`POST /v1/memories/trigger`).
   *
   * Fires the symbol tripwire on the in-flight `action` (or explicit `entities`)
   * and returns the `lesson` / `procedure` insights past sessions recorded about
   * those symbols — advisory, not a mandate. No query, and **not** metered
   * against the monthly quota, so it's safe to call before every tool use.
   * `mode: "compose"` (default) additionally runs an LLM relevance gate over
   * `task` and assembles a markdown block into `context`; `retrieve` returns the
   * raw matched rows and leaves `context` null.
   *
   * Throws on HTTP errors like {@link search}. For a hot-path hook that must
   * never block the agent's tool loop, use {@link preToolHook}, which fails soft.
   */
  async trigger(body: TriggerRequest, context: RequestContext = {}): Promise<TriggerResponse> {
    const { body: response } = await this.http.request<TriggerResponse>("POST", "/v1/memories/trigger", {
      body,
      signal: context.signal,
      requestId: context.requestId,
    });
    return response;
  }

  /**
   * Fail-soft sugar over {@link trigger} built for a pre-tool-call hook.
   *
   * Pass the tool call the agent is about to make (`{ tool, args, output? }`) or
   * pre-extracted `{ entities }`, plus at least one scope axis. Returns the
   * inject-ready `context` block (server-assembled under `compose`,
   * client-rendered under `retrieve`) alongside the raw rows.
   *
   * Unlike {@link trigger}, this **never throws on a network error or timeout** —
   * it returns `{ context: "", memories: [], degraded: true }` so a recall
   * hiccup can't stall the tool loop (the server already fails soft too). It
   * *does* throw synchronously on misconfiguration — no scope axis, or no firing
   * signal — since those are caller bugs, not transient failures.
   *
   * @example
   * const { context } = await client.memories.preToolHook(
   *   { tool: "Edit", args: { file_path: "tool_loop.py" } },
   *   { user_id: "alice", task: "fix finalize-on-abort" },
   * );
   * if (context) systemPrompt += `\n\n${context}`;
   */
  async preToolHook(
    signal: ActionContext | { entities: string[] },
    opts: PreToolHookOptions,
  ): Promise<PreToolHookResult> {
    const mode = opts.mode ?? "compose";

    const isEntities =
      "entities" in signal && Array.isArray((signal as { entities: unknown }).entities);
    const action = isEntities ? undefined : (signal as ActionContext);
    const entities = isEntities ? (signal as { entities: string[] }).entities : undefined;

    // Fail LOUD on caller bugs, before any network work — an empty result here
    // would silently mask a missing scope or firing signal.
    if (!opts.user_id && !(opts.group_ids && opts.group_ids.length > 0) && !opts.agent_id && !opts.app_id) {
      throw new Error(
        "preToolHook(): at least one scope axis (user_id, group_ids, agent_id, or app_id) is required",
      );
    }
    const hasActionSignal =
      !!action && (action.tool != null || action.args != null || action.output != null);
    if (!hasActionSignal && !(entities && entities.length > 0)) {
      throw new Error(
        "preToolHook(): pass an `action` (with at least tool/args/output) or non-empty " +
          "`entities` — recall fires on the symbols the agent is touching, not a query",
      );
    }

    const body: TriggerRequest = {
      ...(action ? { action } : {}),
      ...(entities ? { entities } : {}),
      mode,
      include: opts.include,
      task: opts.task,
      user_id: opts.user_id,
      group_ids: opts.group_ids,
      agent_id: opts.agent_id,
      app_id: opts.app_id,
    };

    // Combine an optional client-side timeout with the caller's own signal so
    // either aborts the request; both resolve to a soft, empty result below.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listenedSignal: AbortSignal | undefined;
    if (opts.timeoutMs != null) timer = setTimeout(onAbort, opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else {
        // Track the signal we attach to so the listener is removed in `finally`.
        // `{ once: true }` alone leaks here: a normally-completing call never
        // fires `abort`, so on a long-lived caller signal reused across a busy
        // tool loop each preToolHook would leave a dangling listener.
        opts.signal.addEventListener("abort", onAbort, { once: true });
        listenedSignal = opts.signal;
      }
    }

    try {
      const resp = await this.trigger(body, { signal: controller.signal, requestId: opts.requestId });
      const rows = resp.data ?? [];
      const context =
        mode === "compose"
          ? (resp.context ?? "")
          : (opts.render ?? renderLessonProcedurePrompt)(rows);
      return { context, memories: rows, degraded: false };
    } catch {
      // Any network error / timeout / abort degrades to empty — the hook must
      // not block the agent's tool call.
      return { context: "", memories: [], degraded: true };
    } finally {
      if (timer) clearTimeout(timer);
      listenedSignal?.removeEventListener("abort", onAbort);
    }
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
   * When `group_ids` are supplied, group names are resolved from the registry
   * (one `GET /v1/groups`, fired in parallel with the searches) so the prompt
   * can label shared facts by group name rather than opaque id. The lookup is
   * best-effort — on failure the render falls back to id-based labels.
   *
   * Pass `pools` — the scopes to union. Axes within a pool AND; pools OR. At
   * least one pool (each with ≥1 axis) is required.
   *
   * @example
   * // personal + a group ("my stuff OR the trip's stuff"):
   * const { prompt } = await client.memories.recall({
   *   query: "what should I plan for dinner on the trip?",
   *   pools: [{ user_id: "alice" }, { group_ids: ["grp_tokyo2026"] }],
   * });
   *
   * @example
   * // personal + a global app_id knowledge base:
   * const { prompt } = await client.memories.recall({
   *   query: "how do I reset my key?",
   *   pools: [{ user_id: "alice" }, { app_id: "product-kb" }],
   * });
   */
  async recall(
    params: RecallParams,
    options: {
      /** Override the prompt format (phase 2: feed a server-supplied template here). */
      template?: PromptTemplate;
      /** Bypass `renderMemoriesPrompt` entirely with your own renderer. */
      render?: (
        memories: Memory[],
        opts?: {
          groupNames?: Record<string, string>;
          template?: PromptTemplate;
          viewerUserId?: string;
          requestedGroupIds?: string[];
          sourceLabels?: Record<string, string>;
        },
      ) => string;
    } & RequestContext = {},
  ): Promise<RecallResult> {
    const { query } = params;
    const mode = params.mode ?? "compose";
    const limit = params.limit ?? 10;

    // Each pool is one scoped search; recall unions them. Normalize every pool to
    // its NON-EMPTY axes, then require at least one. Dropping an empty axis (a
    // dynamically-built `group_ids: []`) keeps recall from forwarding a vacuous
    // AND-narrowing filter to the server — an empty any-of would turn an
    // otherwise-personal scope into a match-nothing search. A pool left with no
    // real axis (a typo'd `group_id`, `{}`) throws LOUDLY rather than being
    // silently dropped, which would return a result with the requested scope
    // quietly missing. A caller that wants a pool conditionally should omit it.
    const rawPools = params.pools ?? [];
    if (rawPools.length === 0) {
      throw new Error("recall(): `pools` must contain at least one pool");
    }
    const pools: ScopePool[] = rawPools.map((p, i) => {
      // Guard JS callers (no compiler): a bare string group_ids has `.length`, so
      // without this it would masquerade as a non-empty axis and forward an
      // invalid (non-array) scope to the server. Reject it explicitly.
      const gids = p.group_ids as unknown;
      if (gids != null && !Array.isArray(gids)) {
        throw new Error(
          `recall(): pool at index ${i} has a non-array group_ids — it must be ` +
            `an array of group id strings`,
        );
      }
      const np: ScopePool = {};
      if (p.user_id) np.user_id = p.user_id;
      if (p.group_ids && p.group_ids.length > 0) np.group_ids = p.group_ids;
      if (p.agent_id) np.agent_id = p.agent_id;
      if (p.app_id) np.app_id = p.app_id;
      if (!np.user_id && !np.group_ids && !np.agent_id && !np.app_id) {
        throw new Error(
          `recall(): pool at index ${i} has no scope axis — give each pool at ` +
            `least one of user_id, group_ids, agent_id, or app_id`,
        );
      }
      return np;
    });

    const ctx: RequestContext = { signal: options.signal, requestId: options.requestId };

    // Groups requested across all pools — used to label sections and to keep
    // non-group pools from bleeding in the user's other groups.
    const requestedGroupIds = [...new Set(pools.flatMap((p) => p.group_ids ?? []))];
    const requestedSet = requestedGroupIds.length > 0 ? new Set(requestedGroupIds) : null;
    const viewerUserId = pools.find((p) => p.user_id)?.user_id;
    const poolLabel = (p: ScopePool): string =>
      p.group_ids && p.group_ids.length > 0 ? "shared" : p.user_id ? "personal" : "scope";

    const jobs = pools.map((pool) => ({
      pool,
      promise: this.search({ query, mode, limit, ...pool }, ctx),
    }));

    // Resolve group id → name from the registry when any pool targets a group,
    // in parallel with the searches. Best-effort: on failure fall back to {} so
    // the render uses id-based labels rather than failing the whole recall.
    const namesJob: Promise<Record<string, string>> = requestedSet
      ? this.http
          .request<GroupListEnvelope>("GET", "/v1/groups", {
            signal: options.signal,
            requestId: options.requestId,
          })
          .then((r) => Object.fromEntries((r.body.data ?? []).map((g) => [g.id, g.name])))
          .catch((): Record<string, string> => ({}))
      : Promise.resolve({});

    const [envelopes, groupNames] = await Promise.all([
      Promise.all(jobs.map(async (j) => ({ pool: j.pool, env: await j.promise }))),
      namesJob,
    ]);

    // Per-pool deduped, score-ordered lists, plus the higher-scored copy of any
    // row that appears in more than one pool.
    const scopes: RecallScopeStat[] = [];
    const bestById = new Map<string, Memory>();
    const lists: Memory[][] = [];
    // Rows from a non-user, non-group pool (an app/agent KB) carry a source label
    // so the prompt sections them on their own instead of as the user's memories.
    const userRowIds = new Set<string>();
    const sourceLabels: Record<string, string> = {};
    for (const { pool, env } of envelopes) {
      let rows = env.data ?? [];
      // A PLAIN personal pool ({ user_id } with no other axis) returns the
      // caller's rows across ALL their groups. When the recall targets groups,
      // drop that pool's rows tagged solely to OTHER (non-requested) groups so
      // the user's other trips don't bleed in. Only the plain personal pool gets
      // this convenience: any extra axis (app_id/agent_id) — or a group pool — is
      // a deliberate scope, so its rows are returned exactly as the axes select
      // (AND-within-pool), even when tagged to a non-requested group. (No groups
      // requested → nothing filtered.)
      const poolHasGroups = !!(pool.group_ids && pool.group_ids.length > 0);
      const isPlainUserPool =
        !!pool.user_id && !poolHasGroups && !pool.app_id && !pool.agent_id;
      if (requestedSet && isPlainUserPool) {
        rows = rows.filter((m) => {
          const gids = m.group_ids ?? [];
          return gids.length === 0 || gids.some((g) => requestedSet.has(g));
        });
      }
      // An app/agent-only pool is a "source" — label its rows for sectioning.
      const sourceLabel =
        !pool.user_id && !poolHasGroups ? (pool.app_id ?? pool.agent_id) : undefined;
      scopes.push({ scope: poolLabel(pool), count: rows.length });
      for (const m of rows) {
        if (pool.user_id) userRowIds.add(m.id);
        else if (sourceLabel && !(m.id in sourceLabels)) sourceLabels[m.id] = sourceLabel;
        const ex = bestById.get(m.id);
        if (!ex || (m.score ?? -Infinity) > (ex.score ?? -Infinity)) bestById.set(m.id, m);
      }
      lists.push([...rows].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)));
    }
    // A row that also came from a user pool is the user's own — not a source row.
    for (const id of Object.keys(sourceLabels)) {
      if (userRowIds.has(id)) delete sourceLabels[id];
    }

    // Order scopes by their top score, THEN round-robin across them. The
    // round-robin keeps either scope from starving the other when there's room;
    // ordering by head score means a small `limit` (even 1) still yields the
    // globally most-relevant rows rather than always favoring one scope's slot.
    // Scores are comparable (both searches embed the same query).
    lists.sort((a, b) => (b[0]?.score ?? -Infinity) - (a[0]?.score ?? -Infinity));
    const pickedIds = new Set<string>();
    const picked: Memory[] = [];
    for (let i = 0; picked.length < limit; i++) {
      let advanced = false;
      for (const list of lists) {
        const row = list[i];
        if (!row) continue;
        advanced = true;
        if (!pickedIds.has(row.id)) {
          pickedIds.add(row.id);
          picked.push(bestById.get(row.id)!);
          if (picked.length >= limit) break;
        }
      }
      if (!advanced) break;
    }

    // Return the array in score order for consumers; the prompt is sectioned, so
    // cross-scope ordering there doesn't matter.
    const memories = picked.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

    const render = options.render ?? renderMemoriesPrompt;
    return {
      memories,
      prompt: render(memories, {
        groupNames,
        template: options.template,
        viewerUserId,
        requestedGroupIds,
        sourceLabels,
      }),
      scopes,
    };
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
