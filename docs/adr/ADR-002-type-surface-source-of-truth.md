# ADR-002: Hand-authored domain types are the canonical 1.0 surface; generated types are a spec-derived reference

> **Status**: Accepted | **Date**: 2026-06-12 | **Deciders**: M2 reconciliation (adversarial review passed, rev 2)

## Context

The SDK ships two parallel type definitions of the same API:

- **`src/types.ts`** (347 lines) — hand-authored *domain* types: `Memory` (a
  discriminated union over `fact`/`artifact`/`episode`), `SearchRequest`,
  `RecallParams`, `Group`, `IngestJob`, etc. This is the surface every other module
  imports and the one re-exported to consumers. It is ergonomic, documented, and
  shaped for how callers think (`Memory`, `recall(params)`), not how HTTP is wired.
- **`src/generated/types.ts`** (1,353 lines) — produced by
  `npm run gen:types` (`openapi-typescript spec/memory.json -o src/generated/types.ts`).
  It is *operation/path*-shaped (`paths["/v1/memories"]["post"]`,
  `operations["ingest_memories_v1_memories_post"]`, `components["schemas"][…]`),
  faithfully mirroring the OpenAPI document. It is **imported nowhere** in `src/` —
  a grep for `generated/types` returns no hits. It is dead relative to the public
  surface.

Two pieces of in-tree documentation frame this as unfinished business pointing in a
particular direction:

1. `src/types.ts:1-2` header: *"Hand-written types matching `openapi/memory_v2.json`.
   Regenerate the canonical version with `npm run gen:types` once the spec is final."*
   This implies the generated file is the eventual canonical surface and the
   hand-authored one is interim.
2. The roadmap feature `wire-generated-types` (m2/s5) restates that as a 1.0 step.

Both contain a concrete defect: **`openapi/memory_v2.json` does not exist.** The
`gen:types` script reads `spec/memory.json`, and that is the only spec file on disk.
So the documented source of truth for the type surface names a phantom file, and the
"regenerate the canonical version" instruction, taken literally, would either fail or
silently generate from a different source than the comment claims.

A second, related cluster of unfinished type-surface work is the set of
**declared-but-unwired forward fields** — types that exist in `src/types.ts` but have
no request-side trigger or resolution helper behind them:

- `Memory.expanded?: Record<string, Memory[]>` (`types.ts:74`) — an expansion field
  on responses, but there is no `expand` parameter on search/list/recall to request
  it, and no spec-documented request trigger for it.
- `PromptTemplate` (`types.ts:283`) — its own doc says it exists so that *"a future
  API endpoint can return xmem's preferred template and the SDK renders with it."*
  No such endpoint exists; only the client-side `DEFAULT_PROMPT_TEMPLATE` +
  per-call override (`recall(..., { template })`) is wired today.
- `IngestJobResult.memories_superseded_by: Record<string,string>` (`types.ts:119`) —
  a typed old-id → new-id map returned by ingest, with no SDK helper to follow the
  chain (i.e. resolve a superseded fact to its replacement).

The forces in tension:

- **Documentary intent vs structural fit.** The in-tree comments say "make the
  generated file canonical," but the generated file is OpenAPI-operation-shaped, not
  the domain surface consumers want. Adopting it wholesale would be a different,
  worse public API, not a finishing touch on the current one.
- **Drift risk of two parallel definitions.** Two hand-/machine-authored type files
  describing the same API can silently disagree. If neither is exercised against the
  other, "in sync with the spec" is an unverified claim.
- **Speculative surface vs honest gaps.** The declared-but-unwired fields are a
  standing invitation to either build speculative features (an `expand` param, a
  template-fetch path) before the server supports them, or to leave typed dead-ends
  in the 1.0 surface with no recorded rationale.
- **"Once the spec is final."** The header gates regeneration on spec finality — but
  the spec is being actively corrected *as part of this same milestone* (ADR-001
  edits auth, error, and the PATCH endpoint). So "regenerate now and freeze" would
  capture a spec mid-correction.

This ADR covers the type-surface decision for `m2/s5` (the `type-surface-finalization`
project). ADR-001 covers the contract/wire-shape reconciliation; this one covers
which type definitions are canonical and what to do with the unwired forward fields.

## Decision

**The hand-authored `src/types.ts` is the canonical public type surface for 1.0.
`src/generated/types.ts` is retained as a spec-derived *reference* artifact, kept in
sync via `npm run gen:types` (source: `spec/memory.json`), not promoted to the public
surface. We correct the stale source-of-truth references, regenerate the reference
file *after* ADR-001's spec corrections land, and add a reproducibility guard
(`gen:types` + `git diff --exit-code`) that keeps the committed reference provably in
sync with the spec — with full hand-authored-vs-spec conformance assertions scoped as
an optional follow-up, not a 1.0 precondition.**

For the declared-but-unwired forward fields, **we wire only what the live API already
supports today and defer the rest with a recorded rationale:**

- `memories_superseded_by` → **wire now**: add a client-side helper to resolve the
  superseded chain (follow old-id → new-id, fetch the replacement via the existing
  `get()`). It needs no new server capability.
- `Memory.expanded` / an `expand` request parameter → **defer**: no spec-documented
  request-side trigger exists; we do not invent one. The response field stays typed
  (harmless) and is revisited when the API documents `expand`.
- server-supplied `PromptTemplate` → **defer**: no server endpoint returns a template;
  the existing client-side default + per-call override already covers today's need.
  The type stays as the forward-looking contract its own doc describes.

## Rationale

### Key Factors

1. **Canonical-ness should track what consumers depend on, not what a comment
   aspires to.** Every `src/` module and every external consumer imports
   `src/types.ts`. The generated file is imported by nothing. Promoting the generated,
   operation-shaped types to canonical would not "finish" the current surface — it
   would *replace* the domain API (`Memory`, `recall(params)`) with a wire API
   (`operations[...]`, `paths[...]`). That is a downgrade in ergonomics disguised as a
   stabilization step. The hand-authored file is already the contract; we make that
   official instead of pretending the generated file is the destination.

2. **The "make generated canonical" instruction rests on a false premise.** Its own
   pointer, `openapi/memory_v2.json`, does not exist. An instruction that cannot be
   followed literally is not a plan; it is a stale TODO. Correcting the reference to
   `spec/memory.json` and recording the *actual* relationship (hand-authored =
   canonical, generated = reference) replaces aspiration with a decision.

3. **The generated file is a reproducible, spec-faithful reference — not an automatic
   oracle.** Be precise about what keeping it actually buys, because the two surfaces
   are structurally different (the generated file is operation/path-shaped;
   `src/types.ts` is domain-shaped), so a mechanical diff between them is *not*
   available. Two distinct guarantees are on offer, at very different costs:
   - **Reproducibility (cheap, adopted):** `npm run gen:types && git diff --exit-code`
     in the local/pre-publish gate proves the committed reference is exactly what the
     current `spec/memory.json` produces — i.e. nobody hand-edited it and it tracks
     spec changes. This catches reference rot, and gives human reviewers a
     spec-faithful artifact to diff a hand-authored type change against during review.
     It does **not**, by itself, prove the hand-authored `Memory` matches the spec.
   - **Conformance (real but costly, optional):** type-level assertions (e.g.
     `expectAssignable<Memory, components['schemas']['Memory']>` for the handful of
     wire-critical types) *would* mechanically verify the canonical surface against the
     spec-derived schemas. This is genuinely valuable but has authoring/maintenance
     cost and is scoped as an optional hardening, not a precondition.

   We adopt reproducibility now and leave conformance assertions as an explicit
   follow-up. Even at the reproducibility tier, the generated file earns its keep: a
   regenerable, in-tree mirror of the spec is a better review aid and a lower
   reintroduction cost than nothing — which is the honest case for keeping it over
   deletion.

4. **Regenerate after the spec is corrected, not before.** ADR-001 edits the spec
   (auth docs, the PATCH/UpdateRequest removal). Regenerating `src/generated/types.ts`
   *before* those edits would bake the pre-correction spec — including the dead
   `UpdateRequest` — into the reference. Sequencing the regen after ADR-001 makes the
   reference reflect the reconciled 1.0 spec.

5. **Wire support, not speculation.** `memories_superseded_by` is data the server
   *already returns*; a resolver is pure client-side convenience over an existing
   field and the existing `get()`. By contrast, `expand` and a server-supplied
   `PromptTemplate` would require the SDK to call request shapes or endpoints the API
   does not document — building those now is speculative surface that could be wrong
   when the server actually ships them. Wiring the supported field and deferring the
   unsupported ones (with the reason written down) is the honest 1.0 posture and
   directly satisfies the story's "implemented or explicitly closed with rationale"
   bar.

## Consequences

### Positive

- **The public surface stays ergonomic and stable.** Consumers keep `Memory`,
  `recall(params)`, etc.; nothing about the imported types changes at 1.0.
- **The generated file gains a purpose.** It goes from dead code to a reproducible,
  spec-derived reference (reproducibility guard now; optional conformance assertions
  later) — a review aid and conformance on-ramp rather than clutter.
- **Source-of-truth docs become true.** The `openapi/memory_v2.json` phantom is
  replaced with `spec/memory.json` everywhere it appears, so a future maintainer
  running `gen:types` gets what the comment promises.
- **No speculative dead-ends ship in 1.0.** Each unwired field is either given a real
  helper (`memories_superseded_by`) or carries a recorded "deferred because the API
  doesn't support it yet" rationale.

### Negative

- **We keep two type files indefinitely.** The hand-authored canonical surface must be
  kept consistent with the spec by hand, rather than being machine-generated.
  *Accepted:* the ergonomic gap between domain and operation types is real; the
  reproducibility guard keeps the *reference* honest, and the optional conformance
  assertions can later verify the canonical surface against it — recovering most of
  the value generation would have given us, without the breaking downgrade.
- **The guard is a new maintenance surface.** The reproducibility guard must be re-run
  (and the reference re-committed) whenever the spec changes; the optional conformance
  assertions, if added, must track legitimate domain-surface evolution. *Accepted:*
  the reproducibility tier is one gate command, and the conformance tier is opt-in and
  scoped to wire-critical types, so neither grows unbounded.
- **Deferred fields remain typed but inert.** `Memory.expanded` and `PromptTemplate`
  stay in the surface without a live trigger, which a reader might mistake for working
  features. *Accepted:* their docstrings already mark them forward-looking, and this
  ADR records the deferral explicitly so the gap is intentional, not silent.

### Neutral

- **Regeneration is sequenced behind ADR-001.** This creates an ordering dependency in
  the sprint (spec corrections → regen) but no functional coupling beyond that.
- **Deleting the generated file remains a future option.** If, after a release or two,
  the conformance assertions are never added and the reference is never consulted in
  review, a later decision can drop it; this ADR does not foreclose that.

### Application — disposition of the type-surface items

| Item | Disposition | Notes |
|------|-------------|-------|
| Canonical surface | Hand-authored `src/types.ts` is canonical; `src/generated/types.ts` is reference | No public-surface change |
| `openapi/memory_v2.json` reference | **Correct** to `spec/memory.json` in `src/types.ts:1-2` (and the roadmap note) | Phantom file → real source |
| `src/generated/types.ts` | **Regenerate** from corrected spec *after* ADR-001 lands; add `gen:types`+`git diff --exit-code` reproducibility guard (conformance assertions optional follow-up) | Reproducible reference |
| `memories_superseded_by` | **Wire now** — client-side superseded-chain resolver over existing `get()` | Additive helper |
| `Memory.expanded` / `expand` param | **Defer** — no documented request trigger | Type stays; rationale recorded |
| server-supplied `PromptTemplate` | **Defer** — no server endpoint; client default suffices | Type stays as forward contract |

## Alternatives Considered

### Alternative 1: Adopt the generated types as the canonical public surface

**Description**: Follow the literal `src/types.ts` header instruction — make
`src/generated/types.ts` the source of truth, re-export it, and rewrite `src/` modules
to consume the operation/path-shaped types, deleting or thinning the hand-authored
file.

**Pros**:
- One machine-generated source, regenerated from the spec — no hand-maintenance, no
  drift by construction.
- Maximally spec-faithful: the public types *are* the spec.

**Cons**:
- The generated types are OpenAPI-operation-shaped. The public API would become
  `operations["search_memories_..."]["requestBody"]` instead of `SearchRequest`, and
  the `Memory` discriminated union (which callers rely on for `m.type`-narrowing)
  would have to be reconstructed by hand anyway.
- It is a breaking change to the entire public surface immediately before 1.0, for a
  *worse* developer experience.
- It bakes the spec — mid-correction under ADR-001 — into the surface.

**Why not chosen**: It optimizes for "machine-generated" over "good public API" and
would degrade ergonomics while breaking every consumer. The generated shape is a
faithful *mirror of HTTP*, not the *domain model* the SDK exists to provide.

### Alternative 2: Delete the generated file entirely

**Description**: Remove `src/generated/types.ts` and the `gen:types` script; commit to
the hand-authored surface as the sole type definition.

**Pros**:
- Eliminates the two-file question and any drift between them outright.
- Smallest tree; nothing dead to explain.

**Cons**:
- Throws away a cheap, reproducible spec-derived reference. Even granting (per Key
  Factor 3) that a regen-and-diff guard only proves *reproducibility*, not full
  conformance, that reference is still the artifact a reviewer diffs a hand-authored
  type change against — and it is the substrate the optional conformance assertions
  would build on. Deleting it forecloses the cheap path to the stronger guarantee.
- Makes future regeneration (if the spec stabilizes and the team wants machine help)
  a from-scratch reintroduction rather than a re-run.

**Why not chosen**: This is the closest alternative, and on the *honest* (weaker)
value of the kept file it is genuinely competitive — if we only ever ship the
reproducibility guard, the file's marginal value is "a review aid + a cheap on-ramp to
conformance assertions." We keep it because that on-ramp matters: the file is *unused*
today, not *useless*, and retaining a regenerable reference costs one gate command
while preserving the option to add real conformance checks. If, after a release or
two, the conformance assertions are never added and the reference is never consulted
in review, revisit and delete (see Neutral consequences).

### Alternative 3: Build the speculative forward fields now (`expand`, server templates)

**Description**: Treat all declared-but-unwired fields as 1.0 work — add an `expand`
parameter wired to `Memory.expanded`, and a template-fetch/cache path for a
server-supplied `PromptTemplate`.

**Pros**:
- Closes every typed dead-end with a working feature; nothing inert in the surface.

**Cons**:
- There is no documented server support for either. The SDK would be guessing the
  request shape for `expand` and inventing an endpoint for templates — likely to be
  wrong when the server actually ships them, then needing a breaking correction.
- Spends 1.0 effort on speculative surface instead of the confirmed gaps.

**Why not chosen**: Building against an undocumented server contract is exactly the
kind of speculative drift this milestone is meant to eliminate. Deferring with a
recorded rationale is the disciplined choice; `memories_superseded_by` is wired
precisely *because* it needs no new server capability.

## Implementation Notes

- **Correct the references**: edit `src/types.ts:1-2` to name `spec/memory.json`
  (matching `package.json`'s `gen:types`), and update the roadmap
  `wire-generated-types` note. Verify `gen:types` runs clean against `spec/memory.json`.
- **Regenerate** `src/generated/types.ts` *after* ADR-001's spec corrections so the
  reference reflects the reconciled 1.0 spec (no dead `UpdateRequest`).
- **Reproducibility guard (now)**: add `gen:types` + `git diff --exit-code` to the
  local/pre-publish gate so the committed reference provably tracks `spec/memory.json`
  and nobody hand-edits the generated file. This proves *reproducibility*, not full
  conformance — state that honestly.
- **Conformance assertions (optional follow-up)**: type-level `expectAssignable`
  checks for the wire-critical types, if/when the team wants the stronger guarantee.
  Scoped as hardening, not a 1.0 precondition.
- **Superseded-chain helper**: *disposition is wire-now* (it needs no new server
  capability). The mechanism — method name, location, and whether it takes an
  `IngestJobResult` or an id — is a **design-doc decision**, not fixed here. Pure
  addition; TDD with mocked `HttpClient`.
- **Deferrals**: leave `Memory.expanded` and `PromptTemplate` typed; ensure their
  docstrings note the deferral, and record the closed-with-rationale outcome on the
  roadmap feature.

All of this is additive or doc/spec-only → a **minor** bump under `RELEASING.md`.

## Validation

- **Canonical surface unchanged**: the public type exports are identical before and
  after (the existing test suites compile and pass without type edits to consumers).
- **References resolve**: `npm run gen:types` runs without error from
  `spec/memory.json`, and no occurrence of `openapi/memory_v2.json` remains in the
  tree (`grep` returns nothing).
- **Reproducibility guard works**: hand-editing the generated reference (or a spec
  change without regen) fails `gen:types` + `git diff --exit-code`; a clean,
  regenerated tree passes. Regeneration after ADR-001 produces a reference with no
  `UpdateRequest`. *(If conformance assertions are added later: desyncing a
  wire-critical hand-authored type from the spec-derived schema fails the assertion.)*
- **Superseded resolver**: unit tests show a superseded id resolves to its replacement
  and a non-superseded id is returned/handled as-is.
- **Deferrals are legible**: a reader of the 1.0 surface can tell `expand` and
  server-templates are intentionally deferred (docstring + this ADR), not forgotten.

## Related Decisions

- **ADR-001** (companion): SDK↔spec wire-contract reconciliation policy. The spec
  corrections it makes are an explicit upstream dependency of the regeneration step
  here.

## References

- `src/types.ts` — header SoT comment (L1-2); `Memory.expanded` (L74);
  `IngestJobResult.memories_superseded_by` (L119); `PromptTemplate` (L283).
- `src/generated/types.ts` — generated, operation/path-shaped, unimported (1,353 lines).
- `package.json` — `gen:types` = `openapi-typescript spec/memory.json -o src/generated/types.ts`.
- `src/memories.ts` — `DEFAULT_PROMPT_TEMPLATE` + `recall(..., { template })`
  client-side template path.
- `RELEASING.md` — pre-1.0 minor-bump policy.

---

## Revision History

| Date | Status | Notes |
|------|--------|-------|
| 2026-06-12 | Proposed | Initial proposal — type-surface source of truth + disposition of declared-but-unwired fields (m2/s5). |
| 2026-06-12 | Proposed (rev 2) | Adversarial-review fixes: replaced the overstated "conformance oracle" with an honest two-tier guard — reproducibility now, conformance assertions optional (B1); re-evaluated the delete alternative against the weaker honest value; moved superseded-helper mechanics to the design doc (S1). |
