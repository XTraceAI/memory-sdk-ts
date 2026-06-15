# Design Doc: M3 — Live-verified contract corrections (verification & corrections)

> **ADR**: [ADR-003](../adr/ADR-003-live-verified-supersession-of-adr-001-dispositions.md) (live-verified supersession of ADR-001's dispositions) | **Related**: [ADR-001](../adr/ADR-001-sdk-spec-reconciliation-policy.md), [ADR-002](../adr/ADR-002-type-surface-source-of-truth.md) | **Date**: 2026-06-15 | **Author**: gitban M3 | **Roadmap**: `m3/s6`

## Overview

This document is the implementation bridge for ADR-003 — applying the live-probed
contract facts (captured in gitban card **2syddu** against
`https://api.production.xtrace.ai` on 2026-06-15) to the SDK and `spec/memory.json`.
ADR-001 reconciled four divergences *blind* (no live credentials); the probe has
now run, fired ADR-001's own revisit trigger, and overturned three of those
dispositions. This design encodes the corrections.

Four work areas, in decreasing evidentiary weight:

- **A3 — a shipped bug.** `parseRateLimit` reads `RateLimit-*`; the live server
  emits `x-ratelimit-*`, so `RateLimitSnapshot` has *never* populated in
  production. Fix the parser to read `x-ratelimit-*` (keep `RateLimit-*` as a
  fallback); redefine the `reset` field's semantics from delta-seconds to
  epoch-seconds (doc-only — the field never populated, so no consumer depends on
  the old reading); correct the spec's header section.
- **A4 — a premise reversal, now fully captured.** `PATCH /v1/memories/{id}` is
  *live* (not 405 as ADR-001 inferred). Its contract is group-membership editing:
  request `{add_group_ids?, remove_group_ids?}` (≥1 required; empty → `422
  empty_patch`), response `200` + the full updated `Memory`. Add
  `memories.patch()`; correct the spec (un-annotate PATCH, drop the false
  405/removed claim, document the membership contract). The A4b "gated on a future
  probe" condition in ADR-003 is **cleared** — card 2syddu's "A4b HAPPY-PATH
  CAPTURED" section recorded the full success contract.
- **A1 — a spec + docs correction (code unchanged).** Every observed non-2xx
  (401/404/422, n=1 each) used the legacy `{error:{type,code,message,request_id,
  details?}}` shape; `parseErrorBody`'s legacy-first branch already handles it (and
  already lifts `error.details`). Correct the spec's "Error envelope" section from
  `{detail:{…}}` to `{error:{…}}`; document that live 422 field errors are carried
  under `error.details.errors[]` as `{field,message,type}`. Add a regression
  fixture proving the live 422 body parses correctly. The `{detail}`/`detail[]`
  branches are *retained* (n=1 observations + the 429 envelope was never captured).
- **A2 — a docs note (no code, no spec change).** Both auth schemes share one
  `(org_id, key_hash)` rate bucket; the apparent "10× quota" was an n=1 cold-start
  artifact, retracted by a controlled re-probe. `Bearer` stays the default.
  Document the shared bucket in the README / `authMode` JSDoc.

The work is **entirely additive plus one bug fix plus spec/doc corrections** — no
shipping default changes (the auth-default flip ADR-003 considered was withdrawn).
Under `RELEASING.md`'s pre-1.0 policy this is a **minor** bump: **v0.3.0 → v0.4.0**.

## Requirements

The implementation is complete when:

1. **`RateLimitSnapshot` populates against the live header family.**
   `parseRateLimit` reads `x-ratelimit-limit/remaining/reset`, with `RateLimit-*`
   retained as a fallback; a 200 carrying `x-ratelimit-*` yields a defined
   snapshot. The bug (snapshot always `undefined` in production) is fixed.
2. **`reset` semantics are documented as epoch-seconds.** `RateLimitSnapshot.reset`
   JSDoc states it is an absolute epoch-seconds timestamp (was delta-seconds), with
   the doc-only redefinition rationale recorded (field never populated).
3. **`memories.patch()` edits group membership.** `memories.patch(id, {
   add_group_ids?, remove_group_ids? }): Promise<Memory>` exists, validates ≥1
   field client-side (throws before the call on an empty patch, mirroring the
   server's `empty_patch`), PATCHes `/v1/memories/{id}`, and returns the full
   updated `Memory`.
4. **The spec matches the live wire.** `spec/memory.json` documents the error
   envelope as `{error:{…}}` (with 422 fields under `error.details.errors[]`), the
   rate-limit headers as `x-ratelimit-*` (with `-reset` = epoch seconds), and the
   live PATCH group-membership contract (the false 405/removed claim and the
   self-contradiction removed).
5. **The auth shared-bucket fact is documented.** The README / `authMode` JSDoc
   records that `Bearer` and `x-api-key` share one `(org_id, key_hash)` bucket and
   that scheme choice carries no quota advantage. `Bearer` remains the default.
6. **`delete()`'s docstring no longer asserts a falsehood.** Its "the memory API
   has no update endpoint" claim is corrected (PATCH exists for membership editing;
   *content* corrections still flow through ingest/supersede).
7. **The reproducibility guard still passes.** After the spec edits,
   `npm run check:types-sync` is green (`gen:types` regenerates
   `src/generated/types.ts` from the corrected spec, committed in isolation).
8. **Tolerance is retained, not pruned.** The `{detail}`/`detail[]` branches and
   the `RateLimit-*` fallback stay (n=1 observations + uncaptured 429), with
   regression coverage for each.
9. **All existing tests pass unchanged**, and every new work item ships with
   tests written first (TDD, mocked fetch only) and a `typecheck → test →
   check:types-sync → build` that is green.

## Current State

- **`src/http.ts`** — `request()` returns `{ body, status, requestId, rateLimit }`.
  `parseRateLimit` (L156-174) reads `RateLimit-Limit/Remaining/Reset` only — the
  `x-` prefix is literal, so against the live `x-ratelimit-*` headers it **never
  matches** and `rateLimit` is always `undefined` in production. It already drops
  absent/empty/whitespace headers (`raw.trim() === ""` guard, L162) and applies
  `Number.isFinite` (L164). `authMode` defaults to `'bearer'` (L192) — unchanged by
  this work.
- **`src/errors.ts`** — `RateLimitSnapshot` (L8-15); `reset` JSDoc says
  "seconds until the window resets" (delta semantics, L13). `parseErrorBody`
  (L94-140) is legacy-first: branch 1 reads `{error:{…}}` and lifts
  `error.details` (L108); branches 2-4 handle `detail` array/object/string. The
  live 401/404/422 bodies all land in branch 1.
- **`src/memories.ts`** — `Memories` has `get()` (L219), `delete()` (L289), `search()`,
  `recall()`, `list()`, the superseded resolvers. There is **no `patch()`**.
  `delete()`'s docstring (L284-288) asserts *"the memory API has no update
  endpoint"* — false per the live probe.
- **`src/types.ts`** — `Memory` (L91), `ApiErrorBody` (L383, the legacy `{error:{…}}`
  shape). There is **no PATCH request type**. The header (L1-5) already references
  `spec/memory.json` (ADR-002 fix landed in M2).
- **`src/groups.ts`** — uses `PATCH /v1/groups/{id}` already (L48-55); a useful
  precedent for shaping `memories.patch()`.
- **`spec/memory.json`** — "Error envelope" section documents `{detail:{code,
  message}}` and a FastAPI `detail:[{loc,msg,type}]` 422 (both **wrong** vs live);
  "Response headers" documents `RateLimit-*` (**wrong** — live is `x-ratelimit-*`);
  the PATCH op (L596-660) is annotated `deprecated: true` with a *"[REMOVED
  server-side — returns 405]"* summary (L601) and a long "REMOVED SERVER-SIDE"
  description (L602), referencing `UpdateRequest` (`{text,metadata}`, schema L1523).
  Spec L113 simultaneously treats PATCH as a *live* API-key-only op — the
  self-contradiction ADR-003 calls out. `ErrorEnvelope`/`ErrorDetail` schemas
  (L815-834) model the wrong `{detail}` shape. The auth section already documents
  `Bearer`/`Token`/`x-api-key` and `(org_id, key_hash)` bucketing (no spec change
  needed for A2).
- **`package.json`** — `"version": "0.3.0"`; `gen:types` (L49),
  `check:types-sync` (L50), and `prepublishOnly` (L52, which already chains
  `typecheck → test → check:types-sync → build`).
- **Tests** — vitest, mocked fetch (`src/errors.test.ts`, `src/http.test.ts`).
  `errors.test.ts` L170-227 already exercises `RateLimit-*` parsing, the
  non-numeric drop, and the empty/whitespace drop — these become the **fallback**
  regression suite. No CI; the only gate is the local pre-commit
  `typecheck → test → build` (= `prepublishOnly`), run when code is staged.

## Target State

```
                         MemoryClient(options)   authMode default 'bearer' (UNCHANGED)
                                         │
                                         ▼
                                    ┌───────────────────────────────────────┐
                                    │              HttpClient               │
   request() returns               │  parseRateLimit(headers):             │
   {body,status,requestId,         │    x-ratelimit-limit/remaining/reset  │ ◀ A3 fix
    rateLimit?}                     │    └ fallback: RateLimit-* (retained) │
                                    │  toError → parseErrorBody({error:{…}})│ (A1: unchanged)
                                    └──────┬──────────────────┬─────────────┘
                                           │                  │
                            ┌──────────────▼──┐      ┌────────▼──────────────────┐
                            │   errors.ts     │      │       memories.ts         │
                            │ RateLimitSnapshot│     │  get / delete / search …  │
                            │  .reset = EPOCH  │ ◀A3 │  patch(id,{add,remove}) ◀ │ A4b
                            │  parseErrorBody  │     │    → Promise<Memory>      │
                            │   (legacy-first) │     │    ≥1-field client guard  │
                            └──────────────────┘     └────────┬──────────────────┘
                                                              │ PATCH /v1/memories/{id}
                                                              │ {add_group_ids?,remove_group_ids?}
                                                              ▼  200 + full Memory
                                                       (empty body → 422 empty_patch)

spec/memory.json  ──(A1 error-envelope · A3 headers · A4a PATCH — ASSERTIVE edits)──▶
                                        gen:types ──▶ src/generated/types.ts ──▶ check:types-sync ✔
README / authMode JSDoc  ──(A2: shared (org_id,key_hash) bucket, no scheme advantage)──▶
```

After all phases: `RateLimitSnapshot` actually populates in production; the SDK can
edit group membership via `memories.patch()`; the spec describes the error
envelope, rate-limit headers, and PATCH contract the live server presents; the
auth shared-bucket fact is documented; and the false "no update endpoint" docstring
is corrected. Every change is additive, a bug fix, or a spec/doc correction.

## Design

### Architecture

This is a **medium** change confined to existing modules — no new module is
introduced. Four logical units map onto the existing surface:

- **A3** lives entirely in `src/http.ts` (`parseRateLimit`) and `src/errors.ts`
  (the `RateLimitSnapshot.reset` JSDoc). Pure header-parsing + doc change.
- **A4b** adds one method to `Memories` (`src/memories.ts`) and one request type
  to `src/types.ts`. It reuses the existing `Memory` return type (the live response
  is a full `Memory`, identical to `GET`) and the existing `request()` plumbing.
- **A1 / A4a** are `spec/memory.json` edits (assertive — we observed the shapes),
  followed by a `gen:types` regen + `check:types-sync` verification, plus the
  `delete()` docstring fix and a `parseErrorBody` live-422 regression fixture.
- **A2** is a README + `authMode` JSDoc note. No code, no spec.

No data flow changes for existing methods. `parseRateLimit` is called on every
response already; only *which* header names it reads changes. `memories.patch()`
is a new leaf that uses the same `http.request()` path as every other method.

### Key Design Decisions

**KD-1 — `parseRateLimit`: x-prefixed primary, `RateLimit-*` fallback, per-field.**
The live server emits `x-ratelimit-limit/remaining/reset`. The fix reads the
x-prefixed name first and falls back to the un-prefixed name **per field**, so a
deployment that mixes families (or a future revision that reverts) still parses:

```ts
const num = (name: string): number | undefined => { /* existing trim + isFinite guard */ };
const pick = (xName: string, plainName: string): number | undefined =>
  num(xName) ?? num(plainName);
const limit     = pick("x-ratelimit-limit",     "RateLimit-Limit");
const remaining = pick("x-ratelimit-remaining", "RateLimit-Remaining");
const reset     = pick("x-ratelimit-reset",     "RateLimit-Reset");
```

*Why per-field fallback, not "all-x-or-all-plain":* `Headers.get()` is
case-insensitive but the `x-` prefix is a literal part of the name, so the two
families are genuinely distinct lookups. A per-field `??` is the smallest change
that prefers the proven-live family while keeping ADR-003's retained tolerance
(ADR-003 A3: "keep `RateLimit-*` as a fallback"). The existing
empty/whitespace/`Number.isFinite` guards (the `num` helper) are preserved
verbatim — they are not coupled to the header name and their regression tests
(`errors.test.ts` L208-227) must keep passing unchanged. *Why x-prefixed wins on a
tie:* it is the measured-live family; `RateLimit-*` is the unobserved-but-tolerated
fallback, so the proven shape takes precedence.

**KD-2 — `reset` is redefined as epoch-seconds (doc-only).** The live `-reset` is
an absolute epoch timestamp (e.g. `1781491860`), not delta-seconds. The
`RateLimitSnapshot.reset` JSDoc is rewritten to say so. *Why this is safe and
doc-only:* the field has **never populated in production** (the parser never
matched), so no consumer can depend on the old delta-seconds reading — this is a
deliberate redefinition of a value that was always `undefined`, not a silent
behavioural break. The SDK does **not** convert the value (it surfaces the raw
parsed number); any consumer-facing duration math is the caller's, and the JSDoc
warns explicitly not to treat it as a delta. ADR-003 A3 mandates this redefinition.

**KD-3 — `memories.patch()` lives on `Memories`, validates ≥1 field client-side,
reuses `Memory` as the return.** The method sits alongside `get`/`delete` on the
`Memories` class (it has `http` and the `/v1/memories/{id}` path family). It mirrors
the server's `empty_patch` contract by throwing **before** the call when neither
`add_group_ids` nor `remove_group_ids` carries an entry:

```ts
async patch(
  id: string,
  changes: MemoryPatchRequest,
  context: RequestContext = {},
): Promise<Memory> {
  const add = changes.add_group_ids ?? [];
  const remove = changes.remove_group_ids ?? [];
  if (add.length === 0 && remove.length === 0) {
    throw new Error(
      "memories.patch(): provide at least one of add_group_ids or remove_group_ids " +
        "(the server rejects an empty patch with 422 empty_patch)",
    );
  }
  const body: MemoryPatchRequest = {};
  if (add.length > 0) body.add_group_ids = add;
  if (remove.length > 0) body.remove_group_ids = remove;
  const { body: res } = await this.http.request<Memory>(
    "PATCH",
    `/v1/memories/${encodeURIComponent(id)}`,
    { body, signal: context.signal, requestId: context.requestId },
  );
  return res;
}
```

*Why a client-side guard instead of letting the server 422:* the server's
`empty_patch` is a real round-trip a caller can avoid; failing fast with an
actionable message is cheaper and clearer, and it mirrors the existing
`recall()` "loud throw on an empty pool" convention (`memories.ts` L420-444). The
guard treats an empty *array* the same as an absent field (both are empty
patches), and only forwards the non-empty arrays on the wire so the request stays
minimal. *Why reuse `Memory` as the return:* the live happy-path capture (card
2syddu) confirmed the response is `200` + the **full** `Memory` object, identical
in shape to `GET /v1/memories/{id}`, with `group_ids` reflecting the edit — so the
existing `Memory` discriminated union is the exact return type; no new response
type is warranted. *Why a new `MemoryPatchRequest` type and not reusing the dead
`UpdateRequest`:* the old `{text,metadata}` `UpdateRequest` is genuinely gone
(content corrections flow through ingest/supersede); the live contract is a
disjoint `{add_group_ids?, remove_group_ids?}`. A fresh hand-authored type on the
ADR-002 canonical surface keeps the dead and live contracts from being conflated.

**KD-4 — `parseErrorBody` is unchanged; A1 is spec + docs + one regression test.**
The live 401/404/422 bodies are the legacy `{error:{…}}` shape, which branch 1
already handles — including lifting `error.details` (so the 422's
`error.details.errors[]` is preserved verbatim under `MemoryError.details`). No
code change. *Why retain the `{detail}`/`detail[]` branches rather than prune:*
ADR-003 (S1) keeps them — the observations are n=1 per class and the **429 envelope
was never captured**, so pruning the only tolerant fallback on three single
observations is a larger bet than keeping a few fixture-tested lines. We add one
new fixture asserting the *exact live 422 body* parses correctly (proving branch 1
lifts `error.details.errors[]`), and we keep the existing `{detail}`/`detail[]`
tests as the retained-tolerance suite.

**KD-5 — spec edits are assertive (A1/A3/A4a), not annotative.** ADR-003 reverses
ADR-001's additive-only spec posture *for these sections specifically*, because we
are no longer asserting an un-probed claim — we observed the shapes. So the spec's
"Error envelope", "Response headers", and PATCH sections are **rewritten to the
measured wire**, not merely annotated. The dead `UpdateRequest` schema and the
PATCH `{text,metadata}` history are removed from the live contract description (a
brief historical note may remain), and the PATCH op is re-specced to the live
group-membership contract. *Why assertive is correct here:* it is precisely the
condition ADR-001 required before asserting (measured, not guessed), and leaving
the false 405/removed claim would steer consumers away from a working endpoint
(ADR-003 Rationale #2). The regen must stay clean: `gen:types` must still parse the
edited spec, and `check:types-sync` must pass after the regen is committed.

**KD-6 — A2 is a documentation note only.** The spec already documents all three
auth schemes and `(org_id, key_hash)` bucketing, so A2 touches neither code nor
spec. A README / `authMode` JSDoc note records that both schemes hit the same
shared bucket and scheme choice carries no quota advantage. *Why doc-only and why
`Bearer` stays default:* the controlled re-probe (n=8, order reversed) showed the
apparent 10× gap was a first-call/cold-start artifact tracking call *position*, not
scheme, and `remaining` decremented continuously across both schemes — confirming
the shared bucket. With no quota to gain, flipping the default would be a breaking
change for zero benefit (ADR-003 A2; the withdrawn Alternative 3).

### Interface Design (new/changed public surface)

| Surface | Change | Breaking? |
|---|---|---|
| `Memories.patch(id, changes, ctx?)` → `Promise<Memory>` | new method (A4b) | No (additive) |
| `MemoryPatchRequest` (exported type) | new — `{ add_group_ids?: string[]; remove_group_ids?: string[] }` | No (additive) |
| `RateLimitSnapshot.reset` JSDoc | redefined delta-seconds → epoch-seconds | No (doc-only; field never populated) |
| `parseRateLimit` header names | `RateLimit-*` → `x-ratelimit-*` (fallback retained) | No (bug fix; surface unchanged) |
| `Memories.delete()` docstring | corrected (PATCH exists for membership) | No (doc-only) |
| `spec/memory.json` error/headers/PATCH sections | corrected to live wire | No (spec/doc) |
| README / `authMode` JSDoc | shared-bucket note | No (doc-only) |

New `MemoryPatchRequest` is re-exported from `src/index.ts` alongside the other
request types.

```ts
// src/types.ts — hand-authored canonical surface (ADR-002)
/**
 * Body for `PATCH /v1/memories/{id}` — group-membership editing. At least one
 * of `add_group_ids` / `remove_group_ids` must carry an entry (an empty patch
 * is rejected client-side, mirroring the server's `422 empty_patch`). This is
 * the *only* mutate-in-place op on a memory; content corrections flow through
 * ingest/supersede, not here. The old `{text,metadata}` UpdateRequest is gone.
 */
export interface MemoryPatchRequest {
  /** Group ids to add to the memory's membership. */
  add_group_ids?: string[];
  /** Group ids to remove from the memory's membership. */
  remove_group_ids?: string[];
}
```

## Implementation Phases

The phases are ordered so that the spec edits (Phase 3) land *before* the type
regen they feed, mirroring the M2 design doc's Phase-1-before-regen constraint.
Phases 1 and 2 are pure code and independent; Phase 4 is docs-only.

### Phase 1 — A3: fix `parseRateLimit` + redefine `reset` (the shipped bug)

**Goal:** `RateLimitSnapshot` populates against the live `x-ratelimit-*` headers,
with `RateLimit-*` retained as a fallback, and `reset` documented as epoch-seconds.

**Deliverables:**
- `src/http.ts` `parseRateLimit`: per-field `x-ratelimit-*` primary, `RateLimit-*`
  fallback (KD-1); existing trim/`Number.isFinite` guards preserved verbatim.
- `src/errors.ts` `RateLimitSnapshot.reset` JSDoc → epoch-seconds, with the
  doc-only-redefinition rationale (KD-2).
- New + adjusted unit tests in `src/errors.test.ts` (or `src/http.test.ts`).

**Test strategy (TDD, mocked fetch) — write these first:**
- **Given** a 200 with headers `x-ratelimit-limit:30, x-ratelimit-remaining:23,
  x-ratelimit-reset:1781491860` **When** `request()` returns **Then**
  `rateLimit` is `{ limit:30, remaining:23, reset:1781491860 }` (the live capture;
  `reset` surfaced as the raw epoch number, not converted). *(new — the A3 fix)*
- **Given** a 200 with only `RateLimit-Limit:100, RateLimit-Remaining:42,
  RateLimit-Reset:30` (no x-prefixed) **When** `request()` returns **Then**
  `rateLimit` is `{ limit:100, remaining:42, reset:30 }`. *(retained fallback —
  this is the existing `errors.test.ts` L170-178 test, kept green.)*
- **Given** a 200 with **both** families present **When** `request()` returns
  **Then** the `x-ratelimit-*` values win (x-prefixed precedence). *(new)*
- **Given** a 200 with `x-ratelimit-remaining:""` and `x-ratelimit-reset:"   "`
  **When** parsed **Then** those fields are dropped (not coerced to 0). *(the
  existing empty/whitespace drop test, L219-227, re-pointed at x-prefixed names —
  proves the guard survived the rename.)*
- **Given** `x-ratelimit-limit:"not-a-number"` **When** parsed **Then** that field
  is dropped (`Number.isFinite` guard). *(L208-216, re-pointed.)*
- **Given** no rate-limit headers of either family **When** `request()` returns
  **Then** `rateLimit` is `undefined`, nothing throws. *(L202-206, kept.)*

**Infrastructure:** none. **Documentation:** `RateLimitSnapshot.reset` JSDoc (DaC,
part of this phase's DoD).
**Dependencies:** none.
**Definition of done:**
- [ ] `parseRateLimit` reads `x-ratelimit-*` first, `RateLimit-*` as fallback.
- [ ] Live-capture fixture (`x-ratelimit-*`, epoch `reset`) parses to a defined snapshot.
- [ ] `RateLimit-*`-only fallback test still passes (un-prefixed family still parsed).
- [ ] Both-families test confirms x-prefixed precedence.
- [ ] Empty/whitespace and non-numeric drop tests pass against x-prefixed names.
- [ ] `reset` JSDoc states epoch-seconds with the redefinition rationale.
- [ ] `typecheck → test → build` green.

### Phase 2 — A4b: `memories.patch()` + `MemoryPatchRequest`

**Goal:** the SDK can edit group membership via `PATCH /v1/memories/{id}`, returning
the full updated `Memory`, with an empty patch rejected client-side.

**Deliverables:**
- `src/types.ts`: `MemoryPatchRequest` interface (KD-3 / Interface Design).
- `src/memories.ts`: `Memories.patch(id, changes, ctx?)` (KD-3).
- `src/memories.ts`: corrected `delete()` docstring (Requirement 6) — remove the
  "the memory API has no update endpoint" assertion; note PATCH exists for
  membership editing while *content* corrections still flow through
  ingest/supersede.
- `src/index.ts`: export `MemoryPatchRequest`.
- Unit tests in `src/memories.test.ts` (new file or existing memories test suite),
  mocked `HttpClient`.

**Test strategy (TDD, mocked fetch) — write these first, citing card 2syddu's
captured contract:**
- **Given** `patch("mem_1", { add_group_ids: ["grp_x"] })` **When** called against
  a mocked `request()` that returns `200` + a `Memory` with
  `group_ids:["grp_x"]` **Then** the call issues `PATCH /v1/memories/mem_1` with
  body `{ add_group_ids:["grp_x"] }` (no `remove_group_ids` key) and resolves to
  that `Memory`.
- **Given** `patch("mem_1", { remove_group_ids: ["grp_x"] })` against a mock
  returning a `Memory` with `group_ids:[]` **Then** body is
  `{ remove_group_ids:["grp_x"] }` and the resolved memory's `group_ids` is `[]`.
- **Given** `patch("mem_1", { add_group_ids:["a"], remove_group_ids:["b"] })`
  **Then** both keys are sent on the wire.
- **Given** `patch("mem_1", {})` (or `{ add_group_ids: [], remove_group_ids: [] }`)
  **When** called **Then** it **throws** before any `request()` call (empty-patch
  client guard), with a message naming `add_group_ids`/`remove_group_ids` and the
  server's `empty_patch` (mirrors the live `422 empty_patch`). Assert the mock
  `request()` was **not** invoked.
- **Given** the live `422 empty_patch` body
  `{"error":{"type":"invalid_request_error","code":"empty_patch",...}}` returned by
  a mocked `request()` **When** `patch()` *did* send a body the server rejects (a
  defensive path) **Then** the raised `Unprocessable` carries `code:"empty_patch"`.
  *(Documents the server-side contract even though the client guard normally
  prevents reaching it.)*
- **Given** `context.requestId` / `context.signal` **Then** they thread into
  `request()` (parity with `get`/`delete`).

**Infrastructure:** none. **Documentation:** `MemoryPatchRequest` JSDoc, `patch()`
JSDoc (membership-editing usage + the empty-patch contract), corrected `delete()`
docstring.
**Dependencies:** none (independent of Phase 1; uses the existing `request()` path).
**Definition of done:**
- [ ] `patch()` sends only the non-empty arrays and returns the full `Memory`.
- [ ] Empty patch throws client-side; `request()` is not called.
- [ ] `MemoryPatchRequest` exported from `src/index.ts`.
- [ ] `delete()` docstring no longer claims "no update endpoint."
- [ ] `typecheck → test → build` green.

### Phase 3 — A1/A4a spec corrections + regen + the live-422 regression fixture

**Goal:** `spec/memory.json` matches the live wire on the error envelope, rate-limit
headers, and PATCH; the generated reference is regenerated and the guard passes; the
live 422 body is locked as a `parseErrorBody` regression fixture.

**Deliverables (spec — assertive edits, KD-5):**
- **Error envelope section** → `{error:{type,code,message,request_id,details?}}`;
  document that 422 field errors are carried under `error.details.errors[]` as
  `{field,message,type}` (not FastAPI `{loc,msg,type}`). Update the
  `ErrorEnvelope`/`ErrorDetail` component schemas (spec L815-834) and the per-status
  `detail.code = …` response descriptions to the `{error:{…}}` shape / `error.code`.
- **Response headers section** → `x-ratelimit-limit/remaining/reset`; document
  `-reset` = absolute epoch seconds; update the per-status "`Retry-After` and
  `RateLimit-*`" mentions to `x-ratelimit-*`.
- **PATCH `/v1/memories/{memory_id}` op (A4a, L596-660):** drop `deprecated: true`
  and the "[REMOVED server-side — returns 405]" summary/description; document the
  live **group-membership** contract — request `{add_group_ids?, remove_group_ids?}`
  (≥1 required), `200` + `Memory` response, `422 empty_patch` on an empty body;
  replace the `UpdateRequest` `$ref` with the group-membership request schema;
  resolve the self-contradiction (the "removed" note vs spec L113's live API-key-only
  treatment). Remove/retire the dead `UpdateRequest` schema (L1523) from the live
  contract (a one-line historical note that `{text,metadata}` was removed is fine).

**Deliverables (code — the A1 regression fixture):**
- `src/errors.test.ts`: a new fixture asserting the **exact live 422 body**
  `{"error":{"type":"invalid_request_error","code":"invalid_request","message":
  "Request failed validation","request_id":"…","details":{"errors":[{"field":
  "query","message":"Field required","type":"missing"}]}}}` parses (via the live
  `request()` path) to a `MemoryError` with `code:"invalid_request"` and
  `details.errors[0] === {field:"query",message:"Field required",type:"missing"}`
  (proving branch 1 lifts `error.details` verbatim). Plus retained tests confirming
  the live 401 (`code:"http_401"`) and 404 (`code:"memory_not_found"`) bodies parse.
- Keep the existing `{detail}`/`detail[]` branch tests as the retained-tolerance
  suite (ADR-003 S1 — not pruned).

**Deliverables (regen):**
- `npm run gen:types` → regenerate `src/generated/types.ts` from the corrected spec;
  commit the regen **in isolation** (one commit) so the diff is reviewable.
- `npm run check:types-sync` green.

**Test strategy (TDD, mocked fetch):**
- **Given** the live 422 `{error:{…,details:{errors:[…]}}}` body **When**
  `parseErrorBody` runs (via `request()`) **Then** `code` is `"invalid_request"`
  and `details.errors[0]` is the captured field error verbatim. *(A1 regression
  lock — the headline new test.)*
- **Given** the live 401 / 404 bodies **Then** `code` is `"http_401"` /
  `"memory_not_found"` and the message survives.
- **spec validation:** `npx openapi-typescript spec/memory.json` parses clean
  (proven by `gen:types`), and a human diff review confirms the three sections.
- **guard:** `check:types-sync` passes on the committed regen; a spec edit without
  regen fails it (the guard's purpose).

**Infrastructure:** none (the `check:types-sync` script already exists).
**Documentation:** the spec *is* the doc for A1/A4a.
**Dependencies:** the spec edits must land before the regen (intra-phase order).
This phase is independent of Phases 1 and 2 (different files), though it should be
sequenced last so the regen captures a settled spec.
**Definition of done:**
- [ ] Error envelope section + `ErrorEnvelope`/`ErrorDetail` schemas describe
      `{error:{…}}`; 422 `error.details.errors[]` documented.
- [ ] Response-headers section + per-status mentions use `x-ratelimit-*`; `-reset`
      documented as epoch seconds.
- [ ] PATCH op un-annotated; group-membership contract (request/200 Memory/422
      empty_patch) documented; false 405/removed claim and self-contradiction gone;
      dead `UpdateRequest` retired from the live contract.
- [ ] `npx openapi-typescript spec/memory.json` parses without error.
- [ ] `src/generated/types.ts` regenerated and committed in isolation;
      `check:types-sync` green.
- [ ] Live-422 (`error.details.errors[]`), 401, 404 regression fixtures pass;
      `{detail}`/`detail[]` tolerance tests retained and green.

### Phase 4 — A2 docs note + README rate-limit/PATCH docs

**Goal:** the shared-bucket fact and the new capabilities are documented for
consumers.

**Deliverables:**
- `src/http.ts` `AuthMode` JSDoc (L4-10): add a note that both schemes share one
  `(org_id, key_hash)` rate bucket and scheme choice carries no quota advantage —
  `Bearer` stays the default for that reason (no quota incentive to flip).
- README: an auth note (shared bucket / no scheme advantage), a rate-limit note
  (`x-ratelimit-*`, `reset` is epoch-seconds — don't treat it as a duration), and a
  short `memories.patch()` usage example (group-membership editing).
- `CHANGELOG` entry for `0.4.0` (planned): A3 bug fix, `memories.patch()` +
  `MemoryPatchRequest`, spec corrections (error envelope, rate-limit headers,
  PATCH), `reset` epoch redefinition, A2 shared-bucket doc.

**Test strategy:** docs are prose, not code — validation is a human review that the
note matches ADR-003 A2 and the captured re-probe (n=8). No new tests.
**Infrastructure:** none. **Documentation:** this phase *is* the DaC deliverable.
**Dependencies:** Phases 1-3 (the docs describe their behaviour).
**Definition of done:**
- [ ] `authMode` JSDoc records the shared bucket / no scheme advantage.
- [ ] README documents the shared bucket, `x-ratelimit-*`/epoch `reset`, and
      `memories.patch()`.
- [ ] `CHANGELOG` `0.4.0` entry drafted.

### Release

Bump `package.json` `0.3.0 → 0.4.0` (minor; additive + bug fix per `RELEASING.md`).
Call out in the PR/release notes: the A3 rate-limit bug fix (snapshot now
populates; `reset` is epoch-seconds), the new `memories.patch()` group-membership
method, and the spec corrections (error envelope `{error:{…}}`, rate-limit headers
`x-ratelimit-*`, live PATCH contract). **No breaking change** — the auth default is
unchanged. *Not a code card per se — fold into the closeout/PR.*

## Migration & Rollback

**Migration:** additive plus one bug fix. No method signature changes, no removed
exports, no default behaviour change. Consumers upgrade `0.3.x → 0.4.0` with zero
code changes. The one behaviour *change* is the A3 fix: `RateLimitSnapshot` now
populates where it was always `undefined` — strictly more information, never a
regression (a consumer that ignored the always-`undefined` snapshot is unaffected;
one that read it now gets real data). The `reset` redefinition is doc-only because
the field never populated.

**Rollback:** clean `git revert` per phase. Phases 1, 2, 4 are code/doc-isolated;
Phase 3's spec edit + regen are one logical unit (revert the spec and the
regenerated `src/generated/types.ts` together). The only intra-repo ordering
constraint is Phase 3's spec-before-regen.

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| A future deployment emits `RateLimit-*` (un-prefixed) again | Low (snapshot still parses) | Low | `RateLimit-*` retained as a per-field fallback; both-family test locks precedence |
| Pruning the `{detail}` branches would break against the uncaptured 429 | Med | Low | ADR-003 S1 mandates retaining them; tolerance tests kept, not pruned |
| Spec regen produces churn unrelated to the three section edits | Med (noisy diff) | Med | Regen only after the spec edits settle; commit the regen in isolation; `check:types-sync` makes drift visible |
| `gen:types` chokes on the re-specced PATCH op (malformed schema) | Med | Low | `npx openapi-typescript` run as part of Phase 3 DoD before commit; the new request schema mirrors `GroupCreateRequest`'s shape |
| `memories.patch()` return shape differs from the captured `Memory` on some path | Low | Low | Card 2syddu captured the live `200 + full Memory` happy-path (org mutated + cleaned up); return type reuses the existing `Memory` union |
| Client-side empty-patch guard diverges from server semantics | Low | Low | Guard mirrors the captured `422 empty_patch` ("≥1 of add/remove"); a defensive test asserts the server body still maps to `Unprocessable` |
| The `reset` epoch value is mistaken for a delta by a consumer | Low | Med | JSDoc + README explicitly state epoch-seconds and warn against duration math; the SDK surfaces the raw value, does no conversion |

## Roadmap Connection

Serves roadmap node `m3/s6` (verification & corrections) end to end. Mapping:
Phase 1 → the A3 rate-limit-header bug fix; Phase 2 → the A4b `memories.patch()`
capability; Phase 3 → the A1 error-envelope + A4a PATCH spec corrections (+ regen
guard); Phase 4 → the A2 shared-bucket documentation. After execution, set the
relevant `m3/s6` features `done`. This design doc should be linked at the feature
level under `m3/s6` via `upsert_roadmap` `docs_ref` (ADR-003 is the parent node's
`docs_ref`).

## Open Questions

1. **Whether to retire `UpdateRequest` from the spec entirely or keep a one-line
   historical stub.** ADR-003 A4a says drop the false annotation and document the
   live contract; the dead `{text,metadata}` schema can be deleted or kept as a
   one-line "removed" note. Low stakes — sprint-architect's call. (Deleting it is
   cleaner; keeping a note aids upstream diff legibility.)
2. **`check:types-sync` determinism across `openapi-typescript` versions.** A dep
   bump could make the regen diff spuriously (carried over from the M2 design's
   Open Question 3). Pin/record the generator version if the guard flaps.
3. **Pruning the `{detail}`/`detail[]` dead branches (deferred, maintainer call).**
   ADR-003 retains them pending a fuller capture (including a real 429). Out of
   scope here; a follow-up once the 429 envelope is captured.

## Out of Scope / Follow-ups

- **Group-create `prompt` divergence (flag only).** Card 2syddu's A4b capture noted
  live `POST /v1/groups` **requires** a `prompt` field (422 without it). `src/groups.ts`
  `create()` sends `GroupCreateRequest` (`{name, prompt}`), so the SDK already sends
  it — but this should be verified and, if the spec/types ever make `prompt`
  optional, tightened. Flagged for a follow-up card, not part of this sprint.
- **Pruning the dead `{detail}`/`detail[]` `parseErrorBody` branches** — deferred
  (maintainer call) pending a fuller capture, per ADR-003 S1.
- **Capturing a real 429 envelope.** The read-only probe never forced a 429; the
  envelope is extrapolated, not measured. A future probe with a deliberately
  exhausted bucket should capture it; until then the tolerant fallbacks stay.

---

## Revision History

| Date | Author | Notes |
|------|--------|-------|
| 2026-06-15 | gitban M3 | Initial design — implements ADR-003 (A1/A2/A3/A4) from card 2syddu's live captures into 4 phases (v0.4.0). A4b ungated: card 2syddu's "A4b HAPPY-PATH CAPTURED" recorded the full `200 + Memory` contract, clearing ADR-003's probe gate. |
