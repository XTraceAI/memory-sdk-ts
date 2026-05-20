import { defaultHttpConfig, HttpClient } from "./http.js";
import { Memories } from "./memories.js";

export interface MemoryClientOptions {
  /** API key (`xtk_…`). Required. */
  apiKey: string;
  /** Organization id (`org_…`). Required — paired with the API key on every request. */
  orgId: string;
  /** Override the base URL. Defaults to `https://api.production.xtrace.ai`. */
  baseUrl?: string;
  /** Inject a custom fetch (e.g. for tests, retries-with-instrumentation, or a non-global polyfill). */
  fetch?: typeof globalThis.fetch;
  /** Max retry attempts for 5xx (on idempotent methods) and 429. Default 2. */
  maxRetries?: number;
  /** Provide a custom request-id generator. Default: `req_<uuid>`. */
  requestIdFactory?: () => string;
}

export class MemoryClient {
  readonly memories: Memories;

  constructor(options: MemoryClientOptions) {
    if (!options.apiKey) throw new Error("MemoryClient: apiKey is required");
    if (!options.orgId) throw new Error("MemoryClient: orgId is required");

    const http = new HttpClient(
      defaultHttpConfig({
        apiKey: options.apiKey,
        orgId: options.orgId,
        baseUrl: options.baseUrl,
        fetch: options.fetch,
        maxRetries: options.maxRetries,
        defaultRequestId: options.requestIdFactory,
      }),
    );
    this.memories = new Memories(http);
  }
}
