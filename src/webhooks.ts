import type { HttpClient } from "./http.js";
import type { RequestContext } from "./memories.js";
import type { WebhookConfig, WebhookConfigRequest, WebhookEventPayload } from "./types.js";

/** Options for {@link Webhooks.set} — request context plus secret rotation. */
export interface WebhookSetOptions extends RequestContext {
  /**
   * Mint a fresh signing secret even if a config already exists. Default false
   * preserves the existing secret so a URL/events edit doesn't break the
   * subscriber's signature verification.
   */
  rotateSecret?: boolean;
}

/**
 * Webhook configuration client (`/v1/webhooks`). One webhook per org: register
 * a single endpoint URL and XTrace POSTs a signed event to it when an ingest
 * job finishes — `memory.learning.completed` or `memory.learning.failed` —
 * instead of you polling `client.memories.jobs`.
 *
 * Verify the `X-Webhook-Signature` on each delivery with
 * {@link verifyWebhookSignature}.
 */
export class Webhooks {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create or replace the org's webhook config. Returns it including the
   * signing `secret` — **in full only when freshly minted** (first create, or
   * `{ rotateSecret: true }`); a plain edit returns the secret masked, so store
   * it the first time. Idempotent on `url` / `events` / `enabled`.
   */
  async set(body: WebhookConfigRequest, options: WebhookSetOptions = {}): Promise<WebhookConfig> {
    const { body: res } = await this.http.request<WebhookConfig>("PUT", "/v1/webhooks", {
      body,
      query: options.rotateSecret ? { rotate_secret: "true" } : undefined,
      signal: options.signal,
      requestId: options.requestId,
    });
    return res;
  }

  /** Read the current webhook config. The `secret` is masked. Throws `MemoryNotFound` if none is set. */
  async get(context: RequestContext = {}): Promise<WebhookConfig> {
    const { body } = await this.http.request<WebhookConfig>("GET", "/v1/webhooks", {
      signal: context.signal,
      requestId: context.requestId,
    });
    return body;
  }

  /** Remove the org's webhook config. Idempotent — resolves whether or not one existed. */
  async delete(context: RequestContext = {}): Promise<void> {
    await this.http.request<void>("DELETE", "/v1/webhooks", {
      signal: context.signal,
      requestId: context.requestId,
    });
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time string compare — avoids leaking the secret via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolve a `SubtleCrypto` across runtimes. Browsers, edge runtimes, and
 * Node 19+ expose `globalThis.crypto.subtle`. On Node 18.x the global is gated
 * behind `--experimental-global-webcrypto`, but `node:crypto`'s `webcrypto` is
 * always present — so fall back to it (lazily imported, so non-Node bundles
 * never pull in `node:crypto`).
 */
async function resolveSubtle(): Promise<SubtleCrypto> {
  const fromGlobal = globalThis.crypto?.subtle;
  if (fromGlobal) return fromGlobal;
  try {
    const { webcrypto } = await import("node:crypto");
    if (webcrypto?.subtle) return webcrypto.subtle as SubtleCrypto;
  } catch {
    // Not a Node runtime — fall through to the error below.
  }
  throw new Error(
    "verifyWebhookSignature requires Web Crypto. Available in browsers, edge " +
      "runtimes, and Node 19+; on Node 18 it falls back to node:crypto.webcrypto.",
  );
}

/**
 * Verify the `X-Webhook-Signature` header on an incoming webhook delivery.
 *
 * Recomputes `sha256=<hmac>` over the **raw request body bytes** (sign exactly
 * what you received — don't re-serialize a parsed object, which can reorder
 * keys) and constant-time compares it to the header. Uses Web Crypto, so it
 * runs in Node 18+, browsers, and edge runtimes.
 *
 * @example
 * // Express, raw-body handler:
 * const ok = await verifyWebhookSignature({
 *   payload: req.body,                          // Buffer / raw bytes
 *   signature: req.header("X-Webhook-Signature")!,
 *   secret: process.env.XTRACE_WEBHOOK_SECRET!,
 * });
 * if (!ok) return res.status(401).end();
 * const event = JSON.parse(req.body.toString()) as WebhookEventPayload;
 */
export async function verifyWebhookSignature(input: {
  /** The raw, unparsed request body — a string or the received bytes. */
  payload: string | Uint8Array;
  /** The `X-Webhook-Signature` header value (`sha256=<hex>`). */
  signature: string;
  /** Your webhook signing secret (`whsec_…`). */
  secret: string;
}): Promise<boolean> {
  const subtle = await resolveSubtle();
  const enc = new TextEncoder();
  // Normalize to a fresh ArrayBuffer-backed view (a passed-in Uint8Array may be
  // typed over ArrayBufferLike / SharedArrayBuffer, which Web Crypto rejects).
  const data =
    typeof input.payload === "string" ? enc.encode(input.payload) : Uint8Array.from(input.payload);
  const key = await subtle.importKey(
    "raw",
    enc.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign("HMAC", key, data);
  const expected = `sha256=${toHex(new Uint8Array(mac))}`;
  return timingSafeEqual(expected, input.signature ?? "");
}

/**
 * Verify the signature **and** parse the body in one step. Returns the typed
 * {@link WebhookEventPayload} on success, or throws if the signature doesn't
 * verify — so a verified return value is also a parsed one.
 */
export async function parseWebhookEvent(input: {
  payload: string | Uint8Array;
  signature: string;
  secret: string;
}): Promise<WebhookEventPayload> {
  const ok = await verifyWebhookSignature(input);
  if (!ok) throw new Error("Webhook signature verification failed");
  const text =
    typeof input.payload === "string" ? input.payload : new TextDecoder().decode(input.payload);
  return JSON.parse(text) as WebhookEventPayload;
}
