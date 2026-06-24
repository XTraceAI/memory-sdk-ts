import { describe, it, expect } from "vitest";
import { HttpClient } from "./http.js";
import {
  MemoryError,
  Unauthorized,
  Unprocessable,
  MemoryNotFound,
  RateLimited,
  parseErrorBody,
} from "./errors.js";

/**
 * Build an HttpClient whose `fetch` returns a single crafted Response. This
 * drives the real `request()` -> `toError` -> `parseErrorBody` path so the
 * tests exercise the whole transport stack, not just the pure helper.
 *
 * `maxRetries: 0` keeps error/429 responses from being retried, so each test
 * sees exactly one fetch and throws on the first non-ok response.
 */
function clientReturning(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): HttpClient {
  const fetchImpl = (async () => {
    const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
    return new Response(text, {
      status: opts.status,
      headers: { "content-type": "application/json", ...opts.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return new HttpClient({
    apiKey: "k",
    orgId: "o",
    baseUrl: "https://api.test.local",
    fetch: fetchImpl,
    maxRetries: 0,
    sleep: async () => {},
  });
}

/** Force the error from a request, asserting it is a MemoryError subclass. */
async function errorFrom(client: HttpClient): Promise<MemoryError> {
  try {
    await client.request("GET", "/v1/thing");
  } catch (err) {
    expect(err).toBeInstanceOf(MemoryError);
    return err as MemoryError;
  }
  throw new Error("expected request to throw");
}

describe("parseErrorBody (pure precedence helper)", () => {
  it("legacy {error:{...}} → fields lifted verbatim", () => {
    const parsed = parseErrorBody({
      error: { type: "rate_limit", code: "too_many", message: "slow down", details: { a: 1 } },
    });
    expect(parsed).toEqual({
      type: "rate_limit",
      code: "too_many",
      message: "slow down",
      details: { a: 1 },
    });
  });

  it("spec {detail:{code,message}} → code/message extracted", () => {
    const parsed = parseErrorBody({ detail: { code: "bad_input", message: "nope" } });
    expect(parsed).toEqual({ code: "bad_input", message: "nope" });
  });

  it("422 {detail:[...]} → validation_error code with raw array under details", () => {
    const arr = [{ loc: ["body", "name"], msg: "field required", type: "value_error.missing" }];
    const parsed = parseErrorBody({ detail: arr });
    expect(parsed?.code).toBe("validation_error");
    expect(parsed?.message).toMatch(/1 field error/i);
    expect(parsed?.details).toEqual({ validation_errors: arr });
  });

  it("FastAPI string {detail:'...'} → message is that string, code left to default", () => {
    const parsed = parseErrorBody({ detail: "Not authenticated" });
    expect(parsed).toEqual({ message: "Not authenticated" });
    expect(parsed?.code).toBeUndefined();
  });

  it("array check precedes object check (an array is typeof 'object')", () => {
    // If object-before-array, the array would be treated as detail.code/message
    // (both undefined) and lose the validation_error synthesis.
    const parsed = parseErrorBody({ detail: [{ loc: ["x"], msg: "m", type: "t" }] });
    expect(parsed?.code).toBe("validation_error");
  });

  it("unrecognized shape → null (so errorForStatus applies its defaults)", () => {
    expect(parseErrorBody({})).toBeNull();
    expect(parseErrorBody(null)).toBeNull();
    expect(parseErrorBody("plain string")).toBeNull();
    expect(parseErrorBody({ detail: 42 })).toBeNull();
  });

  it("array `error` is NOT a legacy envelope — falls through to a sibling detail", () => {
    // An array is `typeof 'object'`; the legacy branch must reject it (isRecord)
    // so a populated `detail` envelope is still parsed instead of returning
    // an all-undefined legacy match.
    const parsed = parseErrorBody({ error: [], detail: { code: "rate_limited", message: "slow down" } });
    expect(parsed).toEqual({ code: "rate_limited", message: "slow down" });
  });

  it("array `error` with no detail → null (not an all-undefined legacy match)", () => {
    expect(parseErrorBody({ error: [1, 2] })).toBeNull();
  });
});

describe("error envelope through request() -> toError (capstone)", () => {
  it("legacy {error:{...}} parses exactly as today (regression lock)", async () => {
    const err = await errorFrom(
      clientReturning({
        status: 401,
        body: {
          error: {
            type: "auth_error",
            code: "invalid_key",
            message: "bad key",
            details: { hint: "rotate" },
          },
        },
      }),
    );
    expect(err).toBeInstanceOf(Unauthorized);
    expect(err.status).toBe(401);
    expect(err.errorType).toBe("auth_error");
    expect(err.code).toBe("invalid_key");
    expect(err.message).toBe("bad key");
    expect(err.details).toEqual({ hint: "rotate" });
  });

  it("spec {detail:{code,message}} yields that code/message", async () => {
    const err = await errorFrom(
      clientReturning({ status: 400, body: { detail: { code: "bad_request", message: "missing q" } } }),
    );
    expect(err.code).toBe("bad_request");
    expect(err.message).toBe("missing q");
  });

  it("422 {detail:[...]} → Unprocessable with validation_error + details.validation_errors", async () => {
    const arr = [
      { loc: ["body", "query"], msg: "field required", type: "value_error.missing" },
      { loc: ["body", "limit"], msg: "must be > 0", type: "value_error" },
    ];
    const err = await errorFrom(clientReturning({ status: 422, body: { detail: arr } }));
    expect(err).toBeInstanceOf(Unprocessable);
    expect(err.code).toBe("validation_error");
    expect(err.message).toMatch(/2 field error/i);
    expect(err.details).toEqual({ validation_errors: arr });
  });

  it("FastAPI {detail:'string'} → message is that string", async () => {
    const err = await errorFrom(clientReturning({ status: 403, body: { detail: "Not authenticated" } }));
    expect(err.message).toBe("Not authenticated");
    // code falls back to the status default since the wire carried none
    expect(err.code).toBe("unknown_error");
  });

  it("unrecognized body → generic fallback unchanged (unknown_error)", async () => {
    const err = await errorFrom(clientReturning({ status: 500, body: { unexpected: true } }));
    expect(err.code).toBe("unknown_error");
    expect(err.message).toMatch(/status 500/);
  });
});

describe("live wire bodies (gitban card 2syddu / ADR-003 A1 regression lock)", () => {
  // The deployed Memory API uses the legacy `{error:{...}}` envelope for every
  // non-2xx response — NOT the previously-spec'd `{detail:{...}}` shape. These
  // fixtures are the exact bodies captured against the live API in card 2syddu;
  // they lock the production `request() -> toError -> parseErrorBody` path so a
  // future refactor of parseErrorBody can't silently stop lifting them.

  it("live 422 → Unprocessable with code:invalid_request and per-field error.details lifted", async () => {
    // Verbatim live 422 body (card 2syddu A1). Field errors live under
    // error.details.errors[] as {field,message,type} (NOT FastAPI {loc,msg,type}).
    const err = await errorFrom(
      clientReturning({
        status: 422,
        body: {
          error: {
            type: "invalid_request_error",
            code: "invalid_request",
            message: "Request failed validation",
            request_id: "req_live_422",
            details: { errors: [{ field: "query", message: "Field required", type: "missing" }] },
          },
        },
      }),
    );
    expect(err).toBeInstanceOf(Unprocessable);
    expect(err.status).toBe(422);
    expect(err.errorType).toBe("invalid_request_error");
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe("Request failed validation");
    // The whole `error.details` object is lifted onto MemoryError.details, so the
    // captured per-field error survives verbatim (this is what a consumer reads).
    expect(err.details).toEqual({
      errors: [{ field: "query", message: "Field required", type: "missing" }],
    });
    expect((err.details?.errors as unknown[])[0]).toEqual({
      field: "query",
      message: "Field required",
      type: "missing",
    });
  });

  it("live 401 → Unauthorized with code:http_401, message survives", async () => {
    const err = await errorFrom(
      clientReturning({
        status: 401,
        body: {
          error: {
            type: "authentication_error",
            code: "http_401",
            message: "Invalid API key for this organization",
            request_id: "req_live_401",
          },
        },
      }),
    );
    expect(err).toBeInstanceOf(Unauthorized);
    expect(err.status).toBe(401);
    expect(err.code).toBe("http_401");
    expect(err.errorType).toBe("authentication_error");
    expect(err.message).toBe("Invalid API key for this organization");
  });

  it("live 404 → MemoryNotFound with code:memory_not_found, message survives", async () => {
    const err = await errorFrom(
      clientReturning({
        status: 404,
        body: {
          error: {
            type: "not_found_error",
            code: "memory_not_found",
            message: "Memory abc not found",
            request_id: "req_live_404",
          },
        },
      }),
    );
    expect(err).toBeInstanceOf(MemoryNotFound);
    expect(err.status).toBe(404);
    expect(err.code).toBe("memory_not_found");
    expect(err.errorType).toBe("not_found_error");
    expect(err.message).toBe("Memory abc not found");
  });
});

describe("rate-limit snapshot (KD-2)", () => {
  it("x-ratelimit-* live capture → parsed with raw epoch reset (A3 fix)", async () => {
    // card 2syddu A3: live server emits x-ratelimit-* with reset as an
    // absolute epoch-seconds timestamp (1781491860), not a delta.
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: {
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "23",
        "x-ratelimit-reset": "1781491860",
      },
    });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toEqual({ limit: 30, remaining: 23, reset: 1781491860 });
  });

  it("both families present → x-ratelimit-* wins per field (tie-break)", async () => {
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: {
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "23",
        "x-ratelimit-reset": "1781491860",
        "RateLimit-Limit": "100",
        "RateLimit-Remaining": "42",
        "RateLimit-Reset": "30",
      },
    });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toEqual({ limit: 30, remaining: 23, reset: 1781491860 });
  });

  it("non-numeric x-ratelimit-* values are dropped (num guard preserved)", async () => {
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: { "x-ratelimit-limit": "not-a-number", "x-ratelimit-remaining": "9" },
    });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toEqual({ remaining: 9 });
  });

  it("empty / whitespace x-ratelimit-* values are dropped, not coerced to 0", async () => {
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: {
        "x-ratelimit-remaining": "",
        "x-ratelimit-reset": "   ",
        "x-ratelimit-limit": "50",
      },
    });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toEqual({ limit: 50 });
  });

  it("legitimate 0-valued x-ratelimit-* is preserved, not dropped (?? not ||)", async () => {
    // remaining:0 is an exhausted bucket — the most consumer-visible signal.
    // The num() trim-guard drops "" but must keep "0"; pick() uses ?? so a real
    // 0 wins over an absent RateLimit-* fallback (|| would wrongly discard it).
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: { "x-ratelimit-limit": "0", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
    });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toEqual({ limit: 0, remaining: 0, reset: 0 });
  });

  it("RateLimit-* present → parsed onto the request() return (fallback retained)", async () => {
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: { "RateLimit-Limit": "100", "RateLimit-Remaining": "42", "RateLimit-Reset": "30" },
    });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toEqual({ limit: 100, remaining: 42, reset: 30 });
  });

  it("RateLimit-* present → parsed onto a thrown RateLimited", async () => {
    const client = clientReturning({
      status: 429,
      body: { error: { type: "rate_limit", code: "too_many", message: "slow down" } },
      headers: { "RateLimit-Limit": "100", "RateLimit-Remaining": "0", "RateLimit-Reset": "5", "retry-after": "5" },
    });
    const err = await errorFrom(client);
    expect(err).toBeInstanceOf(RateLimited);
    expect(err.rateLimit).toEqual({ limit: 100, remaining: 0, reset: 5 });
    expect((err as RateLimited).retryAfter).toBe(5);
  });

  it("RateLimit-* present → parsed onto any thrown MemoryError (not just 429)", async () => {
    const client = clientReturning({
      status: 503,
      body: { error: { type: "server_error", code: "unavailable", message: "down" } },
      headers: { "RateLimit-Remaining": "7" },
    });
    const err = await errorFrom(client);
    expect(err.rateLimit).toEqual({ remaining: 7 });
  });

  it("RateLimit-* absent → rateLimit is undefined on the return, nothing throws", async () => {
    const client = clientReturning({ status: 200, body: { ok: true } });
    const res = await client.request("GET", "/v1/thing");
    expect(res.rateLimit).toBeUndefined();
  });

  it("non-numeric RateLimit-* values are dropped (Number.isFinite guard)", async () => {
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: { "RateLimit-Limit": "not-a-number", "RateLimit-Remaining": "9" },
    });
    const res = await client.request("GET", "/v1/thing");
    // limit dropped (non-finite), remaining kept; an all-empty snapshot would be undefined
    expect(res.rateLimit).toEqual({ remaining: 9 });
  });

  it("empty / whitespace RateLimit-* values are dropped, not coerced to 0", async () => {
    const client = clientReturning({
      status: 200,
      body: { ok: true },
      headers: { "RateLimit-Remaining": "", "RateLimit-Reset": "   ", "RateLimit-Limit": "50" },
    });
    const res = await client.request("GET", "/v1/thing");
    // An empty/whitespace header must NOT become 0 (a falsely-exhausted bucket);
    // only the real numeric limit survives.
    expect(res.rateLimit).toEqual({ limit: 50 });
  });
});
