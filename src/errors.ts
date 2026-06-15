/**
 * A point-in-time read of the server's rate-limit bucket, parsed from the
 * `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` response
 * headers (the family the live deployment emits), with the un-prefixed
 * `RateLimit-*` family read as a per-field fallback. Every field is optional: a
 * header that is absent or non-numeric yields `undefined` for that field
 * (never a throw). Use it to back off proactively before you hit a `429`.
 */
export interface RateLimitSnapshot {
  /** `x-ratelimit-limit` (or `RateLimit-Limit`) — the request ceiling for the current window. */
  limit?: number;
  /** `x-ratelimit-remaining` (or `RateLimit-Remaining`) — requests still allowed in this window. */
  remaining?: number;
  /**
   * `x-ratelimit-reset` (or `RateLimit-Reset`) — the absolute **epoch-seconds**
   * timestamp at which the window resets, surfaced as the raw header value with
   * no conversion. This is a point in time, **not** a countdown/duration: to get
   * the seconds remaining, compute `reset - Math.floor(Date.now() / 1000)`.
   *
   * Redefinition note: earlier docs described this as "seconds until the window
   * resets" (a delta). That was incorrect — the live server (gitban card 2syddu,
   * ADR-003 A3) emits an epoch timestamp, and because the snapshot never
   * populated in production before the A3 parser fix (it read the wrong header
   * family), no consumer could have depended on the old delta reading. This is a
   * documentation correction, not a behavioural change.
   */
  reset?: number;
}

export class MemoryError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  /**
   * The server's rate-limit bucket state at failure time, if the response
   * carried `x-ratelimit-*` (or fallback `RateLimit-*`) headers. `undefined`
   * when none were present.
   */
  readonly rateLimit: RateLimitSnapshot | undefined;

  constructor(args: {
    status: number;
    errorType: string;
    code: string;
    message: string;
    requestId?: string;
    details?: Record<string, unknown>;
    rateLimit?: RateLimitSnapshot;
  }) {
    super(args.message);
    this.name = this.constructor.name;
    this.status = args.status;
    this.errorType = args.errorType;
    this.code = args.code;
    this.requestId = args.requestId;
    this.details = args.details;
    this.rateLimit = args.rateLimit;
  }
}

export class BadRequest extends MemoryError {}
export class Unauthorized extends MemoryError {}
export class Forbidden extends MemoryError {}
export class MemoryNotFound extends MemoryError {}
export class Conflict extends MemoryError {}
export class Unprocessable extends MemoryError {}
export class ServerError extends MemoryError {}

export class RateLimited extends MemoryError {
  readonly retryAfter: number | undefined;

  constructor(args: ConstructorParameters<typeof MemoryError>[0] & { retryAfter?: number }) {
    super(args);
    this.retryAfter = args.retryAfter;
  }
}

/** Normalized error body shape produced by {@link parseErrorBody}. */
export interface ParsedError {
  type?: string;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Normalize any server error body to `{ type?, code?, message?, details? }`,
 * handling every envelope the Memory API can emit. Precedence is LIVE-first: the
 * `{error:{…}}` shape is what the deployed API actually returns (ADR-003 live
 * probe / gitban card 2syddu), so it keeps top precedence. The `{detail:…}`
 * branches below are retained as defensive tolerance (the FORMER spec shape +
 * FastAPI defaults) — do NOT remove them or demote `{error}`. Each field is
 * validated to its declared type — a conformant `code` is a string, `details` an
 * object — so verbatim and validated agree:
 *
 * 1. `{ error: {…} }` — the live/canonical `ApiErrorBody` object (spec-documented
 *    since ADR-003). Not an array; an array `error` falls through so a sibling
 *    `detail` envelope is still read.
 * 2. `{ detail: [...] }` — FastAPI 422 validation array. The array carries no
 *    top-level code, so synthesize `code: 'validation_error'`, build a human
 *    `message`, and preserve the raw array under `details.validation_errors`.
 *    (Checked *before* the object branch — a JS array is also `typeof 'object'`.)
 * 3. `{ detail: {…} }` — the FORMER spec envelope (superseded by ADR-003),
 *    retained defensively; `{ code, message }`.
 * 4. `{ detail: "..." }` — FastAPI's default `HTTPException(detail=...)` shape;
 *    `{ message }` only, leaving `code` to the status default.
 * 5. anything else → `null`, so {@link errorForStatus} applies its existing
 *    `unknown_error` / generic-message defaults unchanged.
 */
export function parseErrorBody(parsed: unknown): ParsedError | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // 1. Legacy `{ error: {…} }` — top precedence. Must be a plain object: an
  // array `error` is not a legacy envelope, so fall through to let a sibling
  // `detail` envelope (if any) be parsed rather than returning all-undefined.
  const legacy = obj.error;
  if (isRecord(legacy)) {
    const e = legacy;
    return {
      type: typeof e.type === "string" ? e.type : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
      details: isRecord(e.details) ? e.details : undefined,
    };
  }

  const detail = obj.detail;

  // 2. 422 validation array — must precede the object branch.
  if (Array.isArray(detail)) {
    const n = detail.length;
    return {
      code: "validation_error",
      message: `Validation failed: ${n} field error${n === 1 ? "" : "s"}`,
      details: { validation_errors: detail },
    };
  }

  // 3. Spec `{ detail: { code, message } }`.
  if (detail !== null && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    return {
      code: typeof d.code === "string" ? d.code : undefined,
      message: typeof d.message === "string" ? d.message : undefined,
    };
  }

  // 4. FastAPI default `{ detail: "..." }`.
  if (typeof detail === "string") {
    return { message: detail };
  }

  // 5. Unrecognized.
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function errorForStatus(
  status: number,
  body: ParsedError | null,
  requestId: string | undefined,
  retryAfter?: number,
  rateLimit?: RateLimitSnapshot,
): MemoryError {
  const args = {
    status,
    errorType: body?.type ?? "api_error",
    code: body?.code ?? "unknown_error",
    message: body?.message ?? `Memory API request failed with status ${status}`,
    requestId,
    details: body?.details,
    rateLimit,
  };
  if (status === 400) return new BadRequest(args);
  if (status === 401) return new Unauthorized(args);
  if (status === 403) return new Forbidden(args);
  if (status === 404) return new MemoryNotFound(args);
  if (status === 409) return new Conflict(args);
  if (status === 422) return new Unprocessable(args);
  if (status === 429) return new RateLimited({ ...args, retryAfter });
  if (status >= 500) return new ServerError(args);
  return new MemoryError(args);
}
