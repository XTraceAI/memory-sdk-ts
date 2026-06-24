import { errorForStatus, MemoryError, parseErrorBody, RateLimited, ServerError } from "./errors.js";
import type { RateLimitSnapshot } from "./errors.js";

/**
 * How the API key is presented on the wire. `'bearer'` (default) sends
 * `Authorization: Bearer <apiKey>`; `'x-api-key'` sends `x-api-key: <apiKey>`
 * and no `Authorization` header. An enum (not a boolean) so a future `Token`
 * form can be added without renaming.
 *
 * The scheme is purely a wire-format choice — it carries **no rate-limit
 * advantage**. Both schemes are rate-limited against the same
 * `(org_id, key_hash)` bucket, so switching from `Bearer` to `x-api-key` does
 * not buy extra quota. (An early n=1 probe appeared to show a 10× quota
 * difference; a controlled n=8 re-probe showed that was a first-call cold-start
 * artifact tracking call position, not the auth scheme — see card 2syddu and
 * ADR-003 A2 / KD-6.) `Bearer` therefore stays the default.
 */
export type AuthMode = "bearer" | "x-api-key";

export interface HttpClientConfig {
  apiKey: string;
  orgId: string;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  defaultRequestId?: () => string;
  maxRetries: number;
  /** How to present the API key. Defaults to `'bearer'`. */
  authMode?: AuthMode;
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

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<{ body: T; status: number; requestId: string | undefined; rateLimit: RateLimitSnapshot | undefined }> {
    const url = new URL(path, this.config.baseUrl);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const requestId = options.requestId ?? this.config.defaultRequestId?.() ?? makeRequestId();

    const headers: Record<string, string> = {
      "X-Org-Id": this.config.orgId,
      "X-Request-Id": requestId,
      Accept: "application/json",
    };
    if (this.config.authMode === "x-api-key") {
      headers["x-api-key"] = this.config.apiKey;
    } else {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

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
      const rateLimit = parseRateLimit(response.headers);

      if (response.status === 204) {
        return { body: undefined as T, status: response.status, requestId: respRequestId, rateLimit };
      }

      const text = await response.text();
      const parsed: unknown = text ? safeJson(text) : null;

      if (response.ok) {
        return { body: parsed as T, status: response.status, requestId: respRequestId, rateLimit };
      }

      const err = toError(response, parsed, respRequestId, rateLimit);
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

function toError(
  response: Response,
  parsed: unknown,
  requestId: string | undefined,
  rateLimit: RateLimitSnapshot | undefined,
): MemoryError {
  const body = parseErrorBody(parsed);
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  return errorForStatus(
    response.status,
    body,
    requestId,
    Number.isFinite(retryAfter) ? retryAfter : undefined,
    rateLimit,
  );
}

/**
 * Parse the rate-limit response headers into a {@link RateLimitSnapshot}.
 *
 * The live deployment emits the `x-ratelimit-*` family (`x-ratelimit-limit` /
 * `-remaining` / `-reset`), so each field reads that name first and falls back
 * per-field to the un-prefixed `RateLimit-*` name. The fallback is read with the
 * same `??` selection so the proven-live family wins on a tie; `RateLimit-*` is
 * retained as the unobserved-but-tolerated fallback (ADR-003 A3). The two
 * families are distinct `Headers.get()` lookups — the `x-` prefix is a literal
 * part of the name, not a case variant — so the selection is per field rather
 * than all-x-or-all-plain.
 *
 * `reset` is surfaced as the raw header value: against the live server it is an
 * absolute epoch-seconds timestamp (see {@link RateLimitSnapshot.reset}), and
 * no conversion is applied here. Each field is included only when its header is
 * present and numerically finite; if no field survives, returns `undefined`
 * (an absent bucket, never an empty object). Never throws.
 */
function parseRateLimit(headers: Headers): RateLimitSnapshot | undefined {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    // Drop absent, empty, and whitespace-only headers: `Number("")` and
    // `Number("   ")` both coerce to a finite 0, which would otherwise be
    // reported as `remaining: 0` (a falsely-exhausted bucket).
    if (raw === null || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  // x-ratelimit-* (proven live) first, RateLimit-* as a per-field fallback.
  const pick = (xName: string, plainName: string): number | undefined =>
    num(xName) ?? num(plainName);
  const snapshot: RateLimitSnapshot = {};
  const limit = pick("x-ratelimit-limit", "RateLimit-Limit");
  const remaining = pick("x-ratelimit-remaining", "RateLimit-Remaining");
  const reset = pick("x-ratelimit-reset", "RateLimit-Reset");
  if (limit !== undefined) snapshot.limit = limit;
  if (remaining !== undefined) snapshot.remaining = remaining;
  if (reset !== undefined) snapshot.reset = reset;
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export function defaultHttpConfig(input: {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  defaultRequestId?: () => string;
  authMode?: AuthMode;
}): HttpClientConfig {
  return {
    apiKey: input.apiKey,
    orgId: input.orgId,
    baseUrl: input.baseUrl ?? "https://api.production.xtrace.ai",
    fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
    maxRetries: input.maxRetries ?? 2,
    defaultRequestId: input.defaultRequestId,
    authMode: input.authMode ?? "bearer",
    sleep: defaultSleep,
  };
}
