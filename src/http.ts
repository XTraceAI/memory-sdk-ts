import { errorForStatus, MemoryError, RateLimited, ServerError } from "./errors.js";
import type { ApiErrorBody } from "./types.js";

export interface HttpClientConfig {
  apiKey: string;
  orgId: string;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  defaultRequestId?: () => string;
  maxRetries: number;
  /** Hook for tests; pass a no-op to disable real timers. */
  sleep: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  requestId?: string;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeRequestId(): string {
  // Prefer crypto.randomUUID where available (Node 19+, modern browsers).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? `req_${c.randomUUID()}` : `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<{ body: T; status: number; requestId: string | undefined }> {
    const url = new URL(path, this.config.baseUrl);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const requestId = options.requestId ?? this.config.defaultRequestId?.() ?? makeRequestId();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-Org-Id": this.config.orgId,
      "X-Request-Id": requestId,
      Accept: "application/json",
    };

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const idempotent = method === "GET" || method === "HEAD";
    let attempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.config.fetch(url.toString(), {
          method,
          headers,
          body,
          signal: options.signal,
        });
      } catch (err) {
        if (idempotent && attempt < this.config.maxRetries && !options.signal?.aborted) {
          attempt++;
          await this.config.sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const respRequestId = response.headers.get("x-request-id") ?? requestId;

      if (response.status === 204) {
        return { body: undefined as T, status: response.status, requestId: respRequestId };
      }

      const text = await response.text();
      const parsed: unknown = text ? safeJson(text) : null;

      if (response.ok) {
        return { body: parsed as T, status: response.status, requestId: respRequestId };
      }

      const err = toError(response, parsed, respRequestId);
      const retryable = err instanceof RateLimited || (err instanceof ServerError && idempotent);
      if (retryable && attempt < this.config.maxRetries && !options.signal?.aborted) {
        attempt++;
        const wait = err instanceof RateLimited && err.retryAfter ? err.retryAfter * 1000 : backoffMs(attempt);
        await this.config.sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1000ms... capped at 5s, with light jitter.
  const base = Math.min(250 * 2 ** (attempt - 1), 5000);
  return base + Math.floor(Math.random() * 100);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toError(response: Response, parsed: unknown, requestId: string | undefined): MemoryError {
  const body = (parsed as ApiErrorBody | null)?.error;
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  return errorForStatus(
    response.status,
    body ?? null,
    requestId,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
  );
}

export function defaultHttpConfig(input: {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  defaultRequestId?: () => string;
}): HttpClientConfig {
  return {
    apiKey: input.apiKey,
    orgId: input.orgId,
    baseUrl: input.baseUrl ?? "https://api.production.xtrace.ai",
    fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
    maxRetries: input.maxRetries ?? 2,
    defaultRequestId: input.defaultRequestId,
    sleep: defaultSleep,
  };
}
