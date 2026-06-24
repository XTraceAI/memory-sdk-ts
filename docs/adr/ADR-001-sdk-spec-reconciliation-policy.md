# ADR-001: Treat the shipping SDK as the canonical 1.0 contract and correct the spec to match

> **Status**: Accepted | **Date**: 2026-06-12 | **Deciders**: M2 reconciliation (adversarial review passed, rev 2)

## Context

`@xtraceai/memory` is approaching a 1.0 release. The 1.0 cut is a contract-locking
event: once published, consumers are entitled to rely on the auth scheme, error
codes, endpoint set, and wire shapes behaving as documented, and breaking any of
them after 1.0 carries a major-version cost. Today the SDK and its companion
OpenAPI document, `spec/memory.json`, disagree in four confirmed places. Locking
1.0 while those disagreements stand would bake silent drift into the contract.

The disagreements are not symmetric guesses — they have a consistent shape. The
SDK targets a **newer, deployed** API than `spec/memory.json` describes; the spec
**lags** the implementation. Evidence: the SDK already ships `/v1/groups`,
`group_ids`, `recall`, and per-pool `mode` (added through PRs #6–#8) that the
checked-in spec only partially reflects, and one endpoint the spec still documents
was **removed server-side** and deleted from the SDK because the live API rejected
it. So reconciliation is not "make the SDK obey the spec" — in most cases it is the
reverse, plus hardening the SDK where the spec describes a shape we cannot currently
disprove.

The four divergences (all cross-checked against `src/` and `spec/memory.json`):

1. **Error envelope.** `src/http.ts:117-127` (`toError`) reads `parsed.error`
   (`ApiErrorBody`, `src/types.ts:339-347`), and `src/errors.ts:43-66`
   (`errorForStatus`) defaults `code` to `'unknown_error'` when that field is
   absent. The spec (`spec/memory.json` `info.description` "Error envelope";
   `ErrorEnvelope`/`ErrorDetail` at L795-833) documents a *different* shape:
   `{ "detail": { "code", "message" } }`, with 422 validation failures using the
   FastAPI array form `{ "detail": [ { "loc", "msg", "type" } ] }`
   (`HTTPValidationError`/`ValidationError`, L835-846, L1554-1585). If the live API
   emits the documented `detail` shape, `MemoryError.code` silently degrades to
   `'unknown_error'` and `message` to the generic `"Memory API request failed
   with status N"` — the HTTP-status-derived subclass is still correct, but the
   stable code consumers are told to switch on is lost.

2. **Auth header.** `src/http.ts:44` sends `Authorization: Bearer <key>`. The spec's
   security schemes (`spec/memory.json` L1820-1837; `info.description`
   "Authentication") document only `Authorization: Token <key>` (`BearerToken`,
   `bearerFormat: "Token"`) **or** `x-api-key: <key>`, always paired with
   `X-Org-Id`. The `Bearer` form matches **neither** documented scheme verbatim —
   yet it has shipped since the initial commit, through v0.2.1. A published SDK that
   authenticated with a rejected scheme would 401 on every call; it does not. The
   strongest evidence that the maintainers probe the live API (not just publish) is
   commit `a7da7a9`'s own message — *"the old calls already 4xx against the live
   API"* — i.e. they observe real status codes from the deployed server. That same
   commit proves the deployed API actively diverges from this spec (it dropped
   `metadata`, added `group_ids`; see divergence 5 below).

3. **Rate-limit headers.** `src/http.ts:77,119` reads only `x-request-id` and
   `retry-after`. The spec (`info.description` "Response headers"; 429 descriptions)
   documents `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` on
   **every** response — the bucket state for the `(org_id, key_hash)` pair. A
   caller has no way to throttle proactively today; it can only react to a 429.

4. **Update endpoint.** The spec defines `PATCH /v1/memories/{memory_id}` with an
   `UpdateRequest` body (`spec/memory.json` L514, L602, L1522-1551). The SDK has no
   `update()` method, and `src/memories.ts:230` asserts the API has none. Git
   history is decisive: commit `a7da7a9` / PR #6 **removed** `memories.update()`
   and `UpdateRequest` with the message *"PATCH /v1/memories/{id} was removed
   server-side (returns 405). Corrections flow through ingest."* The spec is simply
   stale here.

5. **`metadata` field (surfaced during review).** The same commit `a7da7a9`
   **dropped** `metadata` from `Memory` and `IngestRequest` ("dropped
   server-side"), so the SDK no longer models it. But `spec/memory.json`'s
   `info.description` still documents `metadata` on both the Memory object and the
   ingest contract, **and** the spec's filter DSL section advertises filtering on
   "customer metadata keys." This is a fifth divergence in the same class as the
   four above, and it has a second-order effect: the additive typed-filter-DSL
   feature (B1, a separate project) targets metadata-key filtering against a field
   the SDK deliberately removed. It is in scope for *this* policy only as a spec
   correction; its impact on the filter DSL design is flagged for that feature's
   design doc.

The forces in tension:

- **Contract fidelity vs. shipping reality.** The spec is the *documented* contract;
  the SDK is the *executed* contract. They cannot both be the 1.0 truth where they
  disagree. One must yield.
- **Regression risk vs. spec conformance.** Changing shipping defaults (e.g.
  `Bearer → Token`) to match the spec would, if the spec is the stale side, break
  every existing consumer.
- **Verification gap.** No live-API credentials are available in this environment
  (`XTRACE_API_KEY` / `XTRACE_ORG_ID` unset; `npm run smoke` cannot run). So for the
  error-envelope and auth divergences we can reason from shipping evidence and git
  history, but cannot *probe* the live wire shape right now. The decision framework
  has to be robust to that residual uncertainty rather than gated on resolving it.

This ADR governs the `spec-contract-alignment` project (roadmap `m2/s5`). A
companion ADR (ADR-002) covers the type-surface source-of-truth question. The
additive search capabilities (typed filter DSL, first-class `include[]`,
`searchAll()`) are feature work, not contract decisions, and are out of scope here.

## Decision

**We adopt a single reconciliation policy for the 1.0 cut: where the SDK and
`spec/memory.json` disagree, the proven, shipping SDK behaviour is the canonical
contract, and `spec/memory.json` is corrected to match it. Where the spec describes
a wire shape we cannot currently disprove and tolerating it is cheap, we
additionally harden the SDK to accept *both* shapes rather than guess which the live
API emits. We do not change any shipping default auth, error, or endpoint behaviour
— only additive hardening and spec corrections.**

Concretely, the policy decides the direction and the risk posture; the four
divergences are *applications* of it (see Consequences → Application), not four
independent decisions. The through-line:

- **Spec yields to the SDK** on settled facts (auth scheme that demonstrably works;
  an endpoint the server already rejects).
- **SDK hardens toward the spec** on unsettled wire shapes that are cheap to tolerate
  and carry no regression risk (parse the documented error envelope *in addition to*
  the current one; read the documented rate-limit headers *in addition to*
  `Retry-After`).
- **No shipping default is altered.** Every change is either purely additive in the
  SDK or confined to `spec/memory.json`.

**Why auth (A2) is hardened differently from errors/rate-limit.** Harden-both is
safe for A1/A3 because *receiving* and tolerating an extra response shape can never
make a request fail. Auth is *request*-side: hardening it means *sending* extra
credentials, and a server that validates "exactly one credential present" could
reject a request carrying both `Authorization: Bearer` **and** `x-api-key`. So the
no-regret property does not transfer automatically. We therefore do **not** send dual
auth headers by default. We do, however, make the spec's primary documented scheme
(`x-api-key`) reachable as an *opt-in* the caller can select — the auth analogue of
harden-both, minus the dual-send risk — so a consumer in an environment where the
gateway prefers `x-api-key` is not stranded. The default remains `Bearer` (proven);
the opt-in is additive and off by default.

- **Spec edits are additive/annotative, not destructive.** Because we cannot probe the
  server we don't control, a spec "correction" must not *assert* something new we
  haven't verified. We *add* the SDK's observed form alongside the documented one
  (auth) and *annotate* removed operations with the evidence (the 405 observation),
  rather than silently rewriting or deleting — preserving history and avoiding
  replacing one un-probed claim with another.

## Rationale

The policy is the natural consequence of three facts established in Context: the
spec is the *lagging* side, the SDK is *published and working*, and we *cannot probe*
the live API right now.

### Key Factors

1. **A published SDK is empirical evidence; a checked-in spec is an assertion.**
   The `Bearer` header and the absence of `update()` are not opinions — they are the
   behaviour of software that demonstrably transacts with the live API (v0.2.1 ships;
   PR #6 removed `update()` *because* the server returned 405). When documented
   intent and observed behaviour collide, observed behaviour is the stronger witness
   to what 1.0 consumers will actually experience. Correcting the spec to match it
   removes drift at the source.

2. **Asymmetric cost of being wrong.** Consider auth. If we keep `Bearer` and the
   live API also accepts it (overwhelmingly likely — it ships), nothing breaks. If
   we instead "conform to the spec" by switching to `Token` and the spec is the stale
   side, we break **every** existing consumer on the 1.0 upgrade. The downside of
   trusting the shipping default is bounded (a spec edit); the downside of trusting
   the stale spec is unbounded (a field-wide outage). The policy always chooses the
   bounded-risk side.

3. **Harden-both converts an unknown into a no-regret.** For the error envelope we
   genuinely do not know which shape the live API emits — *both* current behaviours
   ("right subclass, degraded code") are consistent with shipping. Rather than bet on
   one, we parse both. If the live API emits `detail`, we start surfacing real codes
   (a strict improvement); if it emits `error`, behaviour is unchanged. The
   uncertainty stops being a blocker because no outcome is worse than today. The same
   logic makes the rate-limit headers a pure capability add: present → exposed,
   absent → `undefined`, never a regression.

4. **Silent drift violates the story's own success criteria.** `m2/s5` requires that
   *every* confirmed divergence be triaged to a recorded decision and that no silent
   spec drift remain at the 1.0 cut. "Document the gaps and move on" fails that bar by
   construction. A policy that forces each divergence to either change code or change
   the spec is the only one that satisfies it.

## Consequences

### Positive

- **No regression risk.** Because no shipping default changes, existing consumers see
  identical auth/error/endpoint behaviour on upgrade. Every SDK change is additive.
- **The 1.0 contract becomes self-consistent.** After the spec corrections, a reader
  of `spec/memory.json` and a user of the SDK observe the same auth form, the same
  endpoint set, and compatible error handling. The story's "no silent drift" bar is met.
- **Error ergonomics strictly improve or stay equal.** Hardening `toError` to read
  `detail.code`/`detail.message` (and the 422 array) means stable codes surface
  wherever the live API uses the documented shape, with zero downside if it doesn't.
- **Proactive throttling becomes possible.** Surfacing `RateLimit-*` lets callers
  pace themselves instead of only reacting to 429s.
- **The verification gap stops blocking the milestone.** The harden-both posture is
  explicitly designed to be safe under "we can't probe the live API," so M2 can
  proceed without credentials.

### Negative

- **`spec/memory.json` diverges from upstream's checked-in copy.** We are editing the
  spec on our fork. To bound the epistemic risk (we can't probe the server we don't
  control), edits are **additive/annotative**: we *add* the observed `Bearer` form
  alongside the documented schemes and *annotate* removed/dropped items (PATCH,
  `metadata`) with the evidence — we do not delete or rewrite to assert un-probed
  claims. If upstream later "corrects" in the opposite direction (e.g. revives PATCH),
  the annotations make the conflict legible rather than silent. *Accepted:* shipping
  1.0 with a spec we know is wrong is worse, and annotations are individually reversible.
- **Harden-both carries a sliver of permanent complexity.** `toError` will understand
  two envelope shapes forever, even after the live shape is known. *Accepted:* the
  branch is a few lines, fully unit-testable against fixtures of both shapes, and the
  cost of removing it later (once probed) is trivial.
- **Residual empirical uncertainty is recorded, not resolved.** We are asserting
  `Bearer` works and the `detail` envelope *might* be live without a fresh probe.
  *Accepted:* the asymmetric-cost and harden-both reasoning make every residual
  unknown a no-regret; a follow-up smoke run when credentials exist (see Validation)
  can promote any inference to a fact and prune the tolerated branch.

### Neutral

- **`x-api-key` support is deferred, not denied.** The spec's `x-api-key` scheme is a
  legitimate alternative; adding it is additive and safe but is sequenced as optional
  follow-up scope rather than bundled into the default-auth decision.
- **The `delete()` docstring already encodes the A4 outcome** ("corrections flow
  through ingest"), so that part of the contract is consistent in the SDK already; only
  the spec needs the matching correction.

### Application — disposition of the four divergences

| # | Divergence | Direction | Disposition | Breaking? |
|---|-----------|-----------|-------------|-----------|
| A1 | Error envelope (`{error:…}` vs spec `{detail:…}` / 422 `detail[]`) | SDK hardens toward spec | Parse **both** envelope shapes in `toError`/`errorForStatus`; extract `code`/`message` from whichever is present; surface the 422 `detail[]` array in `details` (the array→`details` mapping shape is a design-doc decision, since `MemoryError.details` is typed `Record<string,unknown>`); status-derived subclass unchanged. | No (additive) |
| A2 | Auth header (`Bearer` vs spec `Token`/`x-api-key`) | Spec yields to SDK; SDK gains opt-in | Keep `Bearer` as the canonical **default** (no change to the default path). **Add** an opt-in `x-api-key` auth mode (additive, off by default — the auth analogue of harden-both without dual-send risk). Spec edit is **additive**: document the `Bearer` form *alongside* the existing `Token`/`x-api-key` schemes, not in place of them. | No (additive) |
| A3 | Rate-limit headers (`Retry-After` only vs spec `RateLimit-*`) | SDK adds capability | Additively parse and surface `RateLimit-Limit/Remaining/Reset` alongside the existing `Retry-After` handling. | No (additive) |
| A4 | Update endpoint (spec `PATCH` vs SDK none; server 405) | Spec yields to SDK | **Won't-do** in the SDK (do not re-add `update()`). **Annotate** the `PATCH /v1/memories/{memory_id}` operation + `UpdateRequest` schema in `spec/memory.json` as removed server-side (observed 405, PR #6), documenting that corrections flow through ingest — preserve the entry with a deprecation/removal note rather than silently deleting. | No |
| A5 | `metadata` field (SDK dropped it; spec still documents it + filter DSL) | Spec yields to SDK | **Annotate** the `metadata` references in `spec/memory.json`'s `info.description` (Memory object, ingest contract, filter DSL) as dropped server-side per `a7da7a9`. Hand off the filter-DSL impact to the B1 design doc. | No (spec-only) |

## Alternatives Considered

### Alternative 1: Conform the SDK to the spec

**Description**: Treat `spec/memory.json` as the source of truth. Change the auth
header `Bearer → Token`, re-add `memories.update()` + `UpdateRequest` for the
documented `PATCH`, and rewrite `toError` to read only the `detail` shape.

**Pros**:
- Produces a spec-faithful SDK with no fork-local spec edits.
- Philosophically clean: "the spec is the contract, the code obeys it."

**Cons**:
- Inverts the established direction of drift — the spec is the *lagging* side here,
  so conforming to it means regressing toward stale truth.
- Re-adds an endpoint the server **already rejects with 405** (PR #6's exact reason
  for removal). The SDK would ship a method guaranteed to fail.
- Changing `Bearer → Token` is a live-fire change to a working auth path with no way
  to verify it (no credentials). If `Bearer` is what the live API honours, this
  breaks every consumer.

**Why not chosen**: It optimizes for documentary tidiness at the cost of breaking a
shipping, working contract and reviving a known-dead endpoint. The spec being wrong
is not a reason to make the SDK wrong to match.

### Alternative 2: Document the divergences as known gaps and ship 1.0 anyway

**Description**: Leave both sides as-is. Add a "known divergences" note to the README
or spec and lock 1.0 with the contradictions intact.

**Pros**:
- Zero code/spec churn now; fastest path to a 1.0 tag.
- Honest in the narrow sense that the gaps are written down somewhere.

**Cons**:
- Directly violates `m2/s5`'s success criteria ("no silent spec drift remains at the
  1.0 cut"; every divergence "triaged to a recorded decision").
- Ships a contract that contradicts itself: consumers reading the spec get
  `detail.code` guidance the SDK may not honour, and a `PATCH` endpoint that 405s.
- Locks the drift behind a major-version wall — the costs compound rather than
  resolve.

**Why not chosen**: A "known gap" at a contract-locking event is just deferred drift
with a higher future removal cost. The milestone exists precisely to avoid this.

### Alternative 3: Block M2 on obtaining live-API credentials and probe everything

**Description**: Pause until `XTRACE_API_KEY`/`XTRACE_ORG_ID` are available, run
`npm run smoke` against the live API, empirically settle every wire shape, then
reconcile from facts.

**Pros**:
- Replaces every inference with a measurement — the strongest possible grounding.
- Lets us prune the harden-both branch down to the single real shape.

**Cons**:
- Credentials are not available in this environment; the milestone would stall
  indefinitely on an external dependency.
- Most of the work doesn't need probing: A4 is already settled by git history, A2 by
  shipping evidence, and A3 is additive regardless. Only the error envelope is
  genuinely uncertain — and harden-both already neutralizes that.

**Why not chosen**: It makes the whole milestone hostage to one unavailable input to
resolve a question the harden-both posture already de-risks. Probing is the right
*follow-up* (see Validation), not a *precondition*.

### Alternative 4: Send dual auth headers (`Bearer` + `x-api-key`) by default

**Description**: Apply harden-both literally to auth — send *both* the proven
`Authorization: Bearer` and the spec's primary `x-api-key` on every request, so the
server accepts whichever it honours.

**Pros**:
- The most aggressive de-risk: a request authenticates under either scheme without the
  caller choosing, making auth a true no-regret the way A1/A3 are.
- Zero config burden on consumers.

**Cons**:
- Harden-both is only safe when *tolerating* an extra input; here we'd be *sending*
  extra credentials. A server that validates "exactly one credential present" (a
  common gateway posture) could reject a dual-credential request — turning a working
  auth path into a 4xx for everyone. We cannot probe to rule this out.
- It changes the default request shape, violating the policy's "no shipping default is
  altered" guarantee.

**Why not chosen**: It inverts the policy's risk posture on the request side — the one
place we can't afford a wrong guess. The chosen middle path keeps the proven `Bearer`
default and exposes `x-api-key` as an **opt-in** (A2), capturing the de-risk for
callers who need it without imposing dual-send risk on everyone.

## Implementation Notes

This ADR sets direction; the design doc and cards carry the detail. In scope here:

- **A1**: Extend `toError` (`src/http.ts`) and `errorForStatus` (`src/errors.ts`) to
  recognize `{detail:{code,message}}` and the 422 `{detail:[{loc,msg,type}]}` array
  in addition to the current `{error:{type,code,message}}`. Extraction precedence and
  the `details` mapping for the 422 array are design-doc decisions. Unit tests must
  cover all three fixtures; this is the canonical TDD target.
- **A2**: Default path unchanged. (1) Edit `spec/memory.json` *additively* — security
  schemes (L1820-1837) and the `info.description` "Authentication" block — to document
  the `Bearer` form *alongside* the existing `Token`/`x-api-key` schemes, not in place
  of them. (2) Add an opt-in `x-api-key` auth mode in the HTTP layer (e.g. a config
  flag selecting the header form), additive and off by default — this is a small but
  real code change and gets its own card, separate from the default-auth spec edit.
- **A3**: Parse `RateLimit-Limit/Remaining/Reset` in the HTTP layer and surface them
  additively. The *exposure surface* (on `RateLimited`/`MemoryError`, and/or a
  client-level "last seen" snapshot for successful responses) is a design-doc
  decision, since SDK methods currently return bodies, not header-bearing envelopes.
- **A4**: No SDK code change. Edit `spec/memory.json` to *annotate* the
  `PATCH /v1/memories/{memory_id}` operation (L514/L602) and the `UpdateRequest`
  schema (L1522-1551) as removed server-side (observed 405, PR #6), recording that
  corrections flow through ingest — preserve the entry with a removal note rather than
  deleting it outright.
- **A5**: Spec-only. Annotate the `metadata` references in `info.description` (Memory
  object, ingest contract, filter DSL operator table) as dropped server-side per
  `a7da7a9`. The B1 (typed-filter-DSL) design doc owns the question of whether/how
  metadata filtering is still meaningful.

Because every change is additive or spec-only, this work is a **minor** version bump
under the pre-1.0 policy in `RELEASING.md` (no breaking change). Spec-only edits skip
the code pre-commit gate; the A1/A3 code changes must pass `typecheck → test → build`.

## Validation

We will know this was the right call if:

- **No regression signal.** After release, existing consumers report no auth, error,
  or endpoint behaviour change (the additive-only guarantee holds). Concretely: the
  existing `groups`/`recall`/`ai-sdk` test suites pass unchanged, and the new A1/A3
  tests pass against both-shape fixtures.
- **Self-consistency check passes.** A reader can no longer find a contradiction
  between `spec/memory.json` and the SDK on auth scheme, the endpoint set, or error
  handling. The four table rows are each either code-additive or spec-corrected; none
  remains "documented but unhandled."
- **The probe, when it happens, confirms the inference.** *Revisit trigger:* the first
  time `npm run smoke` runs with real credentials, capture the actual auth acceptance,
  one real error body, and the response headers. If the live error shape is settled,
  prune the unused branch in `toError` and record the fact in this ADR's revision
  history. If `Bearer` is somehow *not* accepted, this decision must be reopened
  immediately — but the shipping evidence makes that outcome very unlikely.

## Related Decisions

- **ADR-002** (companion): type-surface source of truth — hand-authored
  `src/types.ts` as canonical vs the generated `src/generated/types.ts`, and the
  disposition of declared-but-unwired forward fields.

## References

- `spec/memory.json` — `info.description` (auth, error envelope, response headers,
  filter DSL); `ErrorDetail`/`ErrorEnvelope` (L795-833); `HTTPValidationError`/
  `ValidationError` (L835-846, L1554-1585); security schemes (L1820-1837);
  `PATCH /v1/memories/{memory_id}` (L514, L602); `UpdateRequest` (L1522-1551).
- `src/http.ts` — auth header (L44), `toError` (L117-127), header reads (L77, L119).
- `src/errors.ts` — `errorForStatus` and `'unknown_error'` default (L43-66).
- `src/memories.ts` — `delete()` "no update endpoint" docstring (L230).
- `git show a7da7a9` / PR #6 — removal of `memories.update()` + `UpdateRequest`
  (server 405; "corrections flow through ingest").
- `RELEASING.md` — pre-1.0 versioning (breaking changes bump the minor, L51-52).

---

## Revision History

| Date | Status | Notes |
|------|--------|-------|
| 2026-06-12 | Proposed | Initial proposal — reconciliation policy for the four spec-contract-alignment divergences (m2/s5). |
| 2026-06-12 | Proposed (rev 2) | Adversarial-review fixes: auth opt-in (`x-api-key`) folded into A2 + dual-send rejected as Alt 4 (B1); spec edits made additive/annotative (S1); cited `a7da7a9` live-4xx evidence (S2); added the `metadata` divergence as A5 (cross-ADR X1). |
