import type { HttpClient } from "./http.js";
import type { RequestContext } from "./memories.js";
import type {
  Group,
  GroupCreateRequest,
  GroupListEnvelope,
  GroupUpdateRequest,
} from "./types.js";

/**
 * Group registry client (`/v1/groups`). A group is a tagging target: at
 * ingest time the classifier tags extracted memories with the registered
 * groups whose `prompt` they match. A group created without a prompt is a
 * catch-all — it receives every extracted memory the classifier judges
 * shareable. Memories judged personal are never group-tagged, catch-all or
 * not. Register a group here before passing its id in
 * `IngestRequest.group_ids` or `recall`.
 */
export class Groups {
  constructor(private readonly http: HttpClient) {}

  /** Register a new group. Returns it with its server-generated `grp_…` id. */
  async create(body: GroupCreateRequest, context: RequestContext = {}): Promise<Group> {
    const { body: res } = await this.http.request<Group>("POST", "/v1/groups", {
      body,
      signal: context.signal,
      requestId: context.requestId,
    });
    return res;
  }

  /** List every group for the org (active and archived). */
  async list(context: RequestContext = {}): Promise<Group[]> {
    const { body } = await this.http.request<GroupListEnvelope>("GET", "/v1/groups", {
      signal: context.signal,
      requestId: context.requestId,
    });
    return body.data;
  }

  /** Fetch a single group by id. */
  async get(id: string, context: RequestContext = {}): Promise<Group> {
    const { body } = await this.http.request<Group>("GET", `/v1/groups/${encodeURIComponent(id)}`, {
      signal: context.signal,
      requestId: context.requestId,
    });
    return body;
  }

  /** Update a group's `name` / `prompt` / `status`. Omitted fields are unchanged. */
  async update(id: string, patch: GroupUpdateRequest, context: RequestContext = {}): Promise<Group> {
    const { body } = await this.http.request<Group>("PATCH", `/v1/groups/${encodeURIComponent(id)}`, {
      body: patch,
      signal: context.signal,
      requestId: context.requestId,
    });
    return body;
  }

  /**
   * Archive a group — soft (its `status` becomes `"archived"`). Archived
   * groups are dropped from ingest tagging (and land in
   * `IngestJobResult.ignored_group_ids`). Returns the archived group.
   */
  async archive(id: string, context: RequestContext = {}): Promise<Group> {
    const { body } = await this.http.request<Group>("DELETE", `/v1/groups/${encodeURIComponent(id)}`, {
      signal: context.signal,
      requestId: context.requestId,
    });
    return body;
  }
}
