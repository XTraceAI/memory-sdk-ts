# ADR-003: Supersede ADR-001's un-probed dispositions with live-verified contract facts

> **Status**: Accepted | **Date**: 2026-06-15 | **Deciders**: autonomous run (gitban-adr-writer ⇄ gitban-adr-reviewer, approved rev 2) | **Supersedes (in part)**: ADR-001 (A1, A3, A4 dispositions; corrects the A2 quota premise)

## Context

ADR-001 ("Treat the shipping SDK as the canonical 1.0 contract and correct the
spec to match", *Accepted* 2026-06-12) set a reconciliation policy for four
SDK↔`spec/memory.json` divergences and shipped it in v0.3.0 (sprint M2RECON).
That ADR was decided under an explicit, recorded constraint: **no live-API
credentials existed in the environment** ("Verification gap … cannot *probe* the
live wire shape right now"). Its risk posture — "where the spec describes a wire
shape we cannot currently disprove and tolerating it is cheap, harden the SDK to
accept *both* shapes rather than guess" — was a deliberate response to that gap,
and ADR-001's own **Validation** section recorded the exit condition:

> *Revisit trigger:* the first time `npm run smoke` runs with real credentials,
> capture the actual auth acceptance, one real error body, and the response
> headers … If `Bearer` is somehow *not* accepted, this decision must be reopened
> immediately.

Credentials have now been supplied (`.env.local`). The deferred verification
spike (gitban card **2syddu**) was executed on **2026-06-15** against the live
deployment at `https://api.production.xtrace.ai` with a real free-tier key,
read-only/non-mutating calls only (GET list, POST search with a bad body, GET
missing id, PATCH with a probe body, a bad-token 401). The raw bodies and headers
captured there are the evidence base for this ADR. The probe **overturned several
of ADR-001's dispositions** and surfaced one outright SDK bug.

A note on evidentiary strength up front, because it shapes every disposition
below. The error-envelope captures (401/404/422) are **observed at n=1 per error
class** — one real body each, not a statistical sample — and the **429 envelope
was never captured at all** (forcing one requires exhausting a live bucket, which
the read-only probe did not do). The auth finding required a **second,
controlled re-probe** (2026-06-15, n=8, order-reversed) because the first reading
was a confounded n=1; that re-probe is recorded below and it *reversed* the
initial auth conclusion. The dispositions are calibrated to that strength: we
assert where we measured cleanly, and we *retain* tolerance where we did not.

1. **A1 — Error envelope (ADR-001: "harden to both shapes").** Every non-2xx the
   probe produced — a 401, a 404, and a 422, each **observed at n=1** (one body
   per error class, not a sample) — returned the legacy
   `{error:{type,code,message,request_id,details?}}` shape. The spec-documented
   `{detail:{code,message}}` and the FastAPI 422 `detail:[{loc,msg,type}]` array
   were **not produced in these observations**. The live 422 field errors were
   carried under `error.details.errors[]` as `{field,message,type}` — not
   `{loc,msg,type}`. So the SDK's legacy-first `parseErrorBody` is *correct against
   the bodies we saw*, and it is `spec/memory.json`'s "Error envelope" section that
   contradicts them. **The 429 envelope was not captured**, so the error-shape
   evidence covers three error classes, not the full set. The `{detail}` /
   `detail[]` branches ADR-001 added were **not exercised** by these observations.

2. **A2 — Auth (not decided in ADR-001's table beyond "keep `Bearer` default;
   add `x-api-key` opt-in").** Both `Authorization: Bearer` and `x-api-key`
   return 200 with the same key, same endpoint, back-to-back. The *first* probe
   appeared to show a per-scheme rate-limit asymmetry (`Bearer` → `limit: 3`;
   `x-api-key` → `limit: 30`) and was initially read as a **10× quota
   difference**. **That reading was wrong.** It was a confounded n=1: the two
   schemes were sent in fixed order (Bearer first), and `spec/memory.json`
   documents the rate bucket as keyed on `(org_id, key_hash)` — *not* on the auth
   scheme — so a scheme-based difference contradicts the documented bucketing.

   A **controlled re-probe** (2026-06-15, n=8) reversed the call order
   (`x-api-key` *first* this time) and alternated schemes, capturing
   limit/remaining per call:

   | # | scheme | limit | remaining |
   |---|--------|-------|-----------|
   | 1 | x-api-key (first) | 3  | 2  |
   | 2 | bearer            | 30 | 29 |
   | 3 | x-api-key         | 30 | 28 |
   | 4 | bearer            | 30 | 27 |
   | 5 | bearer            | 30 | 26 |
   | 6 | bearer            | 30 | 25 |
   | 7 | bearer            | 30 | 24 |
   | 8 | x-api-key         | 30 | 23 |

   Two facts fall out cleanly. First, the `limit: 3` tracks **call position, not
   scheme**: this time `x-api-key` was called first and *it* got `limit: 3`, so
   the "3" is a first-call / cold-start artifact, not a property of `Bearer`.
   Second, `remaining` **decrements continuously (29 → 23) across both schemes**,
   which means the rate bucket is **shared** regardless of which header is sent —
   exactly the `(org_id, key_hash)` keying the spec describes. **There is no
   scheme-based quota advantage.** The original 10× claim is retracted; this is the
   process catching its own error, and we record it as such.

3. **A3 — Rate-limit headers (ADR-001: "additively parse `RateLimit-*`").** The
   live server emits `x-ratelimit-limit`, `x-ratelimit-remaining`,
   `x-ratelimit-reset` (x-prefixed) on a 200; no bare `RateLimit-*` is present,
   and `-reset` is an **epoch timestamp** (e.g. `1781491860`), not delta-seconds.
   `parseRateLimit` (`src/http.ts`) reads `RateLimit-Limit/Remaining/Reset`.
   `Headers.get()` is case-insensitive, but the `x-` prefix is a literal part of
   the name, so the lookup **never matches** and `RateLimitSnapshot` is *always*
   `undefined` in production. ADR-001 framed A3 as a no-regret capability add
   ("present → exposed, absent → `undefined`, never a regression"); in reality
   the capability never fires. This is a **shipped bug**, not a dead branch.

4. **A4 — PATCH endpoint (ADR-001: "won't-do; server returns 405; annotate spec
   as removed").** This is the largest overturn. `PATCH /v1/memories/{id}` with
   `{"text":"x"}` returned **422 `empty_patch` — "Provide add_group_ids and/or
   remove_group_ids"**, *not* 405. The endpoint **exists**; its current contract
   is **group-membership editing** (`add_group_ids` / `remove_group_ids`), not
   the spec's old `{text,metadata}` `UpdateRequest`. `spec/memory.json` even
   treats PATCH (≈ line 113) as a live, API-key-only operation, contradicting its
   own "removed" annotation. ADR-001's A4 rested on git-history inference (PR #6's
   commit message: "PATCH … was removed server-side, returns 405"); the live
   server falsifies the 405 premise. The *old* `{text,metadata}` `UpdateRequest`
   is still genuinely gone — but a *different* PATCH contract is live and
   unmodelled by the SDK.

The forces in tension:

- **Live fact vs. accepted decision.** ADR-001 is *Accepted* and shipped. Its
  dispositions are now contradicted by direct measurement on the deployment it
  was reasoning about. The accepted record must not be silently mutated, but the
  contract it locks can no longer stand on falsified premises.
- **Epistemic upgrade — and its limits.** ADR-001's posture was correct *for its
  evidence state* (blind harden-both under no-probe). Where the probe measured
  cleanly, holding that posture now would itself be the error — we would be
  shipping a header parse that never matches and disclaiming a method for an
  endpoint that demonstrably exists. But the upgrade is uneven: the auth reading
  was wrong on the first pass and only the controlled re-probe corrected it, and
  the 429 envelope was never seen at all. So the same evidence that *strengthens*
  A1 (for 401/404/422) and A3 also tells us where tolerance must be **kept**, not
  pruned.
- **Scope of the reopen.** The probe was read-only and non-mutating. It did not
  capture the PATCH happy-path response (status code, whether it returns the
  updated `Memory`) or a real 429's headers, because both require mutating the org
  or exhausting a live bucket. Some facts are settled (the 401/404/422 envelopes,
  the rate-limit header prefix, the shared bucket); two probe-shaped holes remain
  (A4's success contract; the 429 envelope), and the dispositions are gated and
  retained accordingly.

This ADR governs the remediation of ADR-001's live-checked dispositions. It is
scoped to the roadmap node tracking this rework (`m3/s6`). It supersedes specific
ADR-001 dispositions; it does **not** rewrite ADR-001's history or its still-valid
elements (A5 `metadata`, the no-regression *principle*, and the policy's
direction-of-drift framing all stand).

Framed honestly, the four reviewed dispositions are not four equally-strong
overturns — they sit on a deliberate evidence gradient, and the unifying intent is
narrow: **correct the contract and docs to the measured wire, no more.**

- **A1** — a spec correction, well-evidenced across three error classes (401/404/422)
  but at n=1 each and with the 429 envelope uncaptured; code unchanged, tolerance
  retained.
- **A3** — a shipped no-op bug fix, airtight: the parser provably never matched the
  live `x-ratelimit-*` headers.
- **A4** — a premise reversal (PATCH is live, not 405) that is well-evidenced for
  the *spec correction* (A4a) and a *method gated on a future probe* (A4b).
- **A2** — a documentation note: the premise that drove an earlier flip was
  corrected by the controlled re-probe, so the conservative `Bearer` default stands
  and we merely document the shared bucket.

## Decision

**We supersede ADR-001's A1, A3, and A4 dispositions, and clarify A2, replacing
each with the live-verified contract fact captured in card 2syddu (as corrected
by the controlled auth re-probe). We treat the live deployment at
`api.production.xtrace.ai` (probed 2026-06-15) as the source of truth wherever it
contradicts an ADR-001 disposition on a *cleanly measured* point, and we correct
`spec/memory.json` to match the live wire, not the lagging documentation. The next
published cut is `0.4.0`, a pre-1.0 minor bump — but a normal additive one: it
carries the new `memories.patch()` method, the A3 bug fix, and the spec
corrections. There is no breaking change, because A2 does not flip any
default (see below).**

ADR-001 remains the canonical record of the *blind* reconciliation; this ADR is
the *probed* correction layered on top of it. Disposition by disposition:

- **A1 (supersede the symmetry).** The live error envelope, in every body we
  observed (401/404/422, **n=1 per class**), was
  `{error:{type,code,message,request_id,details?}}`. We affirm the legacy
  `{error}` branch of `parseErrorBody` as the canonical, primary path (it already
  is) and **correct `spec/memory.json`'s "Error envelope" section to document
  `{error:{…}}`** as the contract — overturning ADR-001's "additive/annotative,
  don't assert" constraint *for this section specifically*, because we are no
  longer asserting an un-probed claim: we observed it. The spec must also document
  that live 422 field errors are carried under `error.details.errors[]` as
  `{field,message,type}`. The `{detail:…}` and `detail[]` branches were not
  exercised by these observations; we **retain them as documented
  belt-and-suspenders** — not least because the **429 envelope was never
  captured** and is extrapolated, not measured, so pruning the only tolerant
  fallback on the strength of three single observations would be a larger bet than
  keeping a few fixture-tested lines. They are demoted from "we don't know which is
  live" to "defensive against shapes this deployment was not seen to emit." A
  maintainer may prune them once a fuller capture (including the 429 body) exists;
  that is not required by, nor authorised against the 429 by, this decision.

- **A2 (documentation note — keep the `Bearer` default; do NOT flip).** We **keep
  `Bearer` as the SDK default `authMode`** — preserving ADR-001's "no shipping
  default is altered" guarantee — and instead **document that both schemes
  authenticate against the same shared `(org_id, key_hash)` rate bucket, with no
  quota difference between them.** The earlier "flip the default to `x-api-key` for
  10× quota" decision is **withdrawn**: the controlled re-probe (n=8, order
  reversed) showed the apparent asymmetry was a first-call/cold-start artifact, not
  a scheme property, and that `remaining` decrements continuously across both
  schemes — confirming the shared bucket the spec already describes. With no quota
  reason to flip, the default stays where ADR-001 put it (proven `Bearer`), and
  `x-api-key` remains the additive opt-in ADR-001 added. **This A2 disposition
  touches neither code nor spec:** `spec/memory.json` already documents
  `Bearer`/`Token`/`x-api-key` (ADR-001 A2a) and already describes
  `(org_id, key_hash)` bucketing, so A2 here is purely a documentation note (e.g.
  in the SDK README / `authMode` doc comment) recording the shared-bucket fact and
  that scheme choice carries no rate advantage. **Withdrawing the flip removes the
  only breaking change this ADR contemplated.**

- **A3 (supersede the header names and fix the bug).** We **correct
  `parseRateLimit` to read `x-ratelimit-limit/remaining/reset`**, keeping
  `RateLimit-*` as a fallback, and we **document that `x-ratelimit-reset` is an
  absolute epoch-seconds timestamp**, not delta-seconds — so any consumer-facing
  representation must not treat it as a duration. We correct the rate-limit header
  section of `spec/memory.json` from `RateLimit-*` to `x-ratelimit-*`. This
  promotes A3 from "additive capability" to "bug fix": the snapshot that ADR-001
  intended to expose has never populated in production. Note that this
  **(re)defines `RateLimitSnapshot.reset`'s JSDoc semantics from delta-seconds to
  epoch-seconds** — a deliberate redefinition, not a silent one. It is doc-only and
  carries no compatibility cost because the field has *never populated* in
  production (the parse never matched), so no consumer can have been depending on
  the old delta-seconds reading. The `RateLimit-*` fallback is retained for the
  same reason A1's tolerance is: it costs little and guards against deployments or
  revisions that emit the un-prefixed family.

- **A4 (supersede the won't-do; split into a spec correction now and a
  probe-gated method).** We **reverse ADR-001's won't-do**, but in two distinct
  parts with different evidence and different timing:

  - **(a) Spec correction — do now, fully evidenced.** We **correct
    `spec/memory.json`**: un-annotate PATCH, drop the false "405 / removed server
    side" claim, document the live **group-membership contract**
    (`add_group_ids` / `remove_group_ids`), and resolve the spec's self-
    contradiction (the "removed" note vs the line treating PATCH as a live
    API-key-only op). This part rests on the cleanly captured live
    `422 empty_patch — "Provide add_group_ids and/or remove_group_ids"`, which
    proves both that the endpoint *exists* (not 405) and what its contract *is*.
    No further probe is required for (a).

  - **(b) Add `memories.patch()` — gated on an implementation-phase live probe.**
    We will add an SDK method that edits group membership via
    `add_group_ids` / `remove_group_ids`. But **the live PATCH happy-path response
    shape (status code; whether it returns the updated `Memory`) was NOT
    captured** — capturing it requires mutating the org with a throwaway memory.
    **Precondition:** before the sprint commits to building (b), the implementation
    phase **must confirm it has org-mutation authority** — a tenant or memory it
    may create *and* delete. If that authority is available, it runs the live
    happy-path probe (status code + response body shape on a throwaway memory) and
    builds the method's return type from the captured shape. **If org-mutation
    authority is not available, ship (a) only and defer (b)** to a follow-up gated
    on the same authority; do not guess the return type.

  The old `{text,metadata}` `UpdateRequest` stays genuinely removed — corrections
  to memory *content* still flow through ingest/supersede; PATCH is for membership,
  not content.

This ADR records the decisions only. The concrete code/spec/test work it unblocks
is enumerated in Implementation Notes for a follow-on design doc and sprint.

## Rationale

The single through-line: **ADR-001 explicitly conditioned its dispositions on the
absence of a live probe and named the probe as the revisit trigger; the probe has
now run, so the trigger fires.** We are not relitigating a sound decision — we are
executing the exit condition ADR-001 wrote for itself. The probe contradicts some
dispositions (A3 outright, A4's 405 premise outright, A1's symmetry for the
classes we saw) and, after a controlled re-probe, *confirms* ADR-001's
conservative choice on others (A2's `Bearer` default). The honest reading is the
point: we correct what we measured cleanly and we keep what we did not.

### Key Factors

1. **Measurement beats inference — when the measurement is clean — and ADR-001
   agreed.** ADR-001's whole posture was "reason from shipping evidence and git
   history because we cannot probe." Each disposition this ADR overturns was an
   *inference* (the `{detail}` shape "might" be live; PATCH "returns 405" per a
   commit message). Where a direct observation of the deployment those inferences
   described is unambiguous — the header prefix is `x-ratelimit-*` and the parser
   never matched (A3); PATCH returns `422 empty_patch`, not 405 (A4a) — it is
   strictly stronger evidence and ADR-001's Validation section commits to honouring
   it. Continuing to ship a header parser that never matches would be choosing the
   weaker witness over the stronger one *after the stronger one arrived*. The A2
   episode is the necessary caveat: a single observation with an unruled-out
   confound is *not* a clean measurement, and we treated it accordingly once the
   re-probe exposed it.

2. **The A4 reversal is a capability we were about to permanently disclaim.**
   "Won't-do" on PATCH was not neutral: it told future engineers the endpoint is
   dead and corrections only flow through ingest. The live contract shows PATCH is
   the *only* way to edit group membership without re-ingesting — a real,
   currently-unreachable capability. Annotating the spec as "removed" would have
   propagated a falsehood into the 1.0 contract and steered consumers away from a
   working operation. Reversing it now, before 1.0 locks, is far cheaper than
   discovering it post-1.0.

3. **The process caught its own error on A2 — and that is a virtue, not a
   blemish.** The first probe read a per-scheme 10× quota gap and very nearly drove
   a default-auth flip (the one breaking change this rework would have carried). A
   controlled re-probe — reversed call order, alternating schemes, n=8 — showed the
   "gap" was a first-call/cold-start artifact and that the bucket is *shared* across
   schemes, exactly as `spec/memory.json`'s `(org_id, key_hash)` keying says. Two
   lessons compound here. First, this is precisely why the rest of this ADR is
   calibrated to evidentiary strength: an n=1 reading with an unruled-out confound
   is not a basis for a breaking change, and we say so. Second, the correct A2
   disposition is the conservative one ADR-001 already chose: keep `Bearer`,
   document the shared bucket. The cost of *not* flipping is now known to be zero
   (no quota is left on the table), so the prior guarantee ("no shipping default is
   altered") stands on its merits, not in spite of evidence.

4. **A3 was sold as no-regret; it is currently no-op.** ADR-001 justified A3 as
   "present → exposed, absent → undefined, never a regression." That framing
   assumed the right header names. With the wrong prefix the snapshot is *always*
   undefined, so the proactive-throttling benefit ADR-001 claimed simply does not
   exist in production. Fixing the prefix is what makes the original A3 promise
   true; it is not new scope, it is delivery of un-delivered scope.

5. **Superseding, not rewriting, preserves institutional memory.** ADR-001's
   blind posture was correct for its evidence state and is itself a useful record
   ("here is how we reasoned when we couldn't probe, and here is the trigger that
   would change it"). Editing ADR-001 in place would erase that reasoning trail.
   A superseding ADR keeps both: the original judgement and the corrected one,
   with the evidence (card 2syddu) that bridges them.

## Consequences

### Positive

- **The 1.0 contract aligns with the deployment that will serve it.** After the
  spec corrections, `spec/memory.json` describes the error envelope, rate-limit
  headers, and PATCH contract the live server actually presents — closing the
  drift ADR-001 closed *on paper* but, for A1/A3, against the wrong target.
- **No breaking change.** Withdrawing the auth-default flip means `0.4.0` is a
  normal additive minor: every existing consumer sees identical default behaviour,
  and ADR-001's "no shipping default is altered" guarantee holds intact.
- **Proactive throttling finally works.** Fixing `parseRateLimit` makes
  `RateLimitSnapshot` actually populate, delivering the capability ADR-001
  intended.
- **A real, working capability becomes reachable.** `memories.patch()` exposes
  group-membership editing that the SDK currently cannot do at all (gated on the
  implementation-phase happy-path probe).
- **The auth bucketing is now documented accurately.** Consumers learn that scheme
  choice carries no rate advantage — closing the door on the same 10× confusion
  this ADR itself nearly fell into.
- **The decision is grounded in observation, honestly scoped.** Every disposition
  cites a captured live response (card 2syddu), and where the observation was thin
  (n=1, or the uncaptured 429) the ADR says so and retains tolerance rather than
  overclaiming.

### Negative

- **We are trusting a single deployment, observed thinly, as the contract.** The
  probe hit one environment (`api.production.xtrace.ai`) on one date, with the
  error envelopes seen at **n=1 per class** and the **429 envelope not seen at
  all**. If another deployment or a future server revision emits `{detail}` or
  `RateLimit-*`, or if the uncaptured 429 differs, the corrected spec would be
  wrong for it. *Accepted:* this is exactly why the `{detail}` branches are
  *retained* rather than pruned, why `RateLimit-*` stays as a parse fallback, and
  why capturing the 429 envelope is a Validation precondition. We correct the
  *primary/documented* contract to the observed shape without discarding the
  tolerance that costs little.
- **The A2 retraction shows a single-observation reading can be flat wrong.** The
  initial 10× claim survived into a draft before the re-probe overturned it.
  *Accepted:* this is a feature of the process, not a defect of the decision — it
  is the reason every remaining disposition is scoped to its evidence and the
  thinly-seen ones (n=1 envelopes, uncaptured 429) keep their fallbacks rather than
  driving irreversible pruning or breaking changes.
- **A4(b) ships gated, not guaranteed.** We commit to adding `memories.patch()`
  only if the implementation phase has org-mutation authority and captures the
  success response shape. *Accepted:* the hole is an explicit precondition (see
  Decision A4 and Validation), not papered over — if the authority or the capture
  is unavailable, the spec correction A4(a) still ships and the method defers, so
  no return type is ever guessed.
- **`spec/memory.json` diverges further from upstream's checked-in copy.** We are
  now *asserting* corrected shapes (A1/A3) rather than only annotating, reversing
  ADR-001's additive-only spec posture. *Accepted:* the assertions are
  measured, not guessed, which is precisely the condition ADR-001 required before
  asserting; the divergence is from a spec we have *proven* stale.

### Neutral

- **ADR-001 stays Accepted and unedited.** Its A5 (`metadata`) disposition and
  its no-regression *principle* are untouched; A1/A3/A4 are superseded and A2 is
  *affirmed* (the re-probe vindicated ADR-001's conservative `Bearer` default). A
  cross-reference is added to ADR-001's Related Decisions / Revision History
  pointing here (a pointer, not a rewrite of its body).
- **The `{detail}` branches remain in the code** as documented defensive fallbacks
  against shapes this deployment was not seen to emit (and against the uncaptured
  429); whether to prune them later is a maintainer cleanup call once a fuller
  capture exists, not a decision this ADR forces.

### Application — disposition of the reviewed items

| # | ADR-001 disposition | Live finding (card 2syddu, + auth re-probe) | This ADR's disposition | Breaking? |
|---|---------------------|-----------------------------|------------------------|-----------|
| A1 | Harden `parseErrorBody` to both `{error}` and `{detail}`/`detail[]`; spec edits additive | 401/404/422 each **observed n=1** as `{error:{…}}`; `{detail}`/`detail[]` not seen; 422 fields under `error.details.errors[]`; **429 not captured** | `{error}` is the documented contract; **correct spec to `{error:{…}}`**; **retain** `{detail}` branches (n=1 + uncaptured 429) | No (spec + docs; code unchanged) |
| A2 | (implicit) keep `Bearer` default; add `x-api-key` opt-in | First probe read 10× gap (`x-api-key` 30 vs `Bearer` 3); **re-probe (n=8, order reversed) refuted it** — "3" is a first-call artifact, bucket is **shared** `(org_id, key_hash)` | **Keep `Bearer` default (do NOT flip); withdraw the 10× claim.** Document the shared bucket (no scheme quota advantage). Doc-only — no code, no spec change | No (default unchanged) |
| A3 | Additively parse `RateLimit-Limit/Remaining/Reset` | Live emits `x-ratelimit-*`; `-reset` = epoch; current parse **never matches** (always `undefined`) | **Fix `parseRateLimit` → `x-ratelimit-*`** (keep `RateLimit-*` fallback); redefine `RateLimitSnapshot.reset` JSDoc → epoch seconds (doc-only, field never populated); correct spec | No (bug fix; additive surface) |
| A4 | **Won't-do**; annotate spec PATCH as removed (405) | PATCH is **live**: `422 empty_patch`; contract = group-membership (`add_group_ids`/`remove_group_ids`); **happy-path shape not captured** | **(a) correct spec now** (un-annotate, document membership contract; well-evidenced); **(b) add `memories.patch()`** gated on org-mutation authority + live happy-path probe; ship (a) only if (b) can't be probed. Old `{text,metadata}` stays gone | No (additive method) — *but* (b) gated on live probe |

## Alternatives Considered

### Alternative 1: Amend ADR-001 in place

**Description**: Edit ADR-001's Application table, Decision, and Validation
sections directly to reflect the live findings; no new ADR.

**Pros**:
- One document to read; no cross-referencing between two ADRs.
- The "current truth" lives in a single accepted record.

**Cons**:
- Destroys the reasoning trail. ADR-001's blind harden-both posture and its
  "probe is the trigger" logic are themselves valuable institutional memory; an
  in-place edit erases *why* we reasoned that way under no-probe.
- Violates the convention that accepted ADRs are immutable records superseded by
  new ones, not retconned — future readers could no longer tell what was decided
  on 2026-06-12 vs what changed on 2026-06-15.
- Conflates two distinct evidence states (inferred vs measured) under one date.

**Why not chosen**: The whole point of the supersession pattern is to preserve the
original judgement *and* the correction. The task is explicit that ADR-001's
history must not be rewritten.

### Alternative 2: Open a fresh unblock issue and defer the rework to a future milestone

**Description**: Treat the falsification as "newly discovered work," file it as a
backlog item / GitHub issue, and leave v0.3.0's dispositions in place until a
later milestone picks it up.

**Pros**:
- No immediate churn; M2RECON closeout stays clean.
- Lets the probe's secondary holes (PATCH happy-path, real 429) be resolved before
  any decision.

**Cons**:
- Leaves a *known* bug (A3: rate-limit snapshot never populates) and a *known*
  falsehood (A4: spec says PATCH removed/405) shipping toward 1.0 — exactly the
  "silent drift at a contract-locking event" ADR-001 existed to prevent.
- Leaves the live error-envelope and rate-limit-header contract undocumented in the
  spec, with no decision record explaining the drift.
- The A4 spec annotation would actively mislead consumers away from a working
  endpoint.

**Why not chosen**: Deferral re-creates the drift ADR-001 was written to kill, and
the cost compounds against the 1.0 wall. The probe's remaining holes are narrow
(one return shape, one 429 header capture) and belong to the *implementation*
phase, not a reason to defer the *decision*.

### Alternative 3: Flip the default `authMode` to `x-api-key` for a larger quota

**Description**: Change the SDK default from `Bearer` to `x-api-key` on the
strength of the first probe's apparent 10× rate-limit gap, accepting the resulting
default-behaviour change (and the breaking-change minor bump it forces). This was
the direction an earlier draft of this ADR actually took.

**Pros**:
- *If* the gap were real, it would move every default-path consumer onto a 10×
  larger rate budget with no caller action — a genuine correctness-of-default win.
- `Bearer` would remain reachable via `authMode`, bounding the regression risk.

**Cons**:
- **Its premise is false.** The controlled re-probe (n=8, order reversed) showed
  the apparent gap was a first-call/cold-start artifact tracking call *position*,
  not auth scheme, and that `remaining` decrements continuously across both schemes
  — the bucket is shared on `(org_id, key_hash)`, exactly as the spec documents.
  There is no quota to gain.
- It would have introduced the *only* breaking change in this rework — and a
  default-path behaviour change at that — entirely on the basis of a confounded
  n=1 observation.

**Why not chosen**: The re-probe eliminated the rationale outright. With no quota
difference, flipping the default would impose a breaking change for zero benefit
while discarding ADR-001's "no shipping default is altered" guarantee for nothing.
This is the alternative the controlled re-probe was *designed* to test, and it
failed the test — keeping `Bearer` (and merely documenting the shared bucket) is
the adopted A2.

## Implementation Notes

This ADR sets direction; a follow-on **design doc** owns the detail (return-type
shape for `patch()`, where `RateLimitSnapshot` is surfaced, the exact spec-section
edits) and a **sprint** carries the cards. In scope to be seeded from here:

- **SDK code**
  - `src/http.ts` `parseRateLimit`: read `x-ratelimit-limit/remaining/reset`
    (retain `RateLimit-*` as fallback); treat `-reset` as epoch seconds. Update
    `RateLimitSnapshot.reset`'s JSDoc to state epoch-seconds (was delta-seconds —
    a deliberate redefinition; doc-only, the field never populated).
  - **No change to the default `authMode`.** It stays `bearer` (A2 affirmed). Do
    not touch `defaultHttpConfig`/`src/client.ts` auth defaults.
  - New `memories.patch()` (`src/memories.ts`): group-membership editing via
    `add_group_ids` / `remove_group_ids`. **Gated:** before building, the
    implementation phase must confirm org-mutation authority and capture the live
    happy-path response (status + body shape) on a throwaway memory. If neither is
    available, defer this method and ship only the spec correction (A4a).
- **Spec corrections (`spec/memory.json`)** — *assertive* (observed) for A1/A3,
  not merely annotative; A2 needs **no** spec change (the spec already documents
  `Bearer`/`Token`/`x-api-key` and `(org_id, key_hash)` bucketing):
  - "Error envelope" section → `{error:{type,code,message,request_id,details?}}`;
    document 422 fields under `error.details.errors[]` as `{field,message,type}`.
  - Rate-limit header section → `x-ratelimit-*`; document `-reset` = epoch seconds.
  - PATCH (A4a): un-annotate as removed; document the group-membership contract;
    drop the false 405/removed claim; resolve the spec's self-contradiction (the
    "removed" note vs the line treating PATCH as a live API-key-only op).
- **Docs (A2)** — a SDK README / `authMode` doc-comment note recording that both
  schemes hit the same shared `(org_id, key_hash)` rate bucket and that scheme
  choice carries no quota advantage. No code, no spec edit.
- **Tests** — fixtures for the observed `{error}` 401/404/422 bodies (including
  `error.details.errors[]`); `parseRateLimit` against `x-ratelimit-*` headers with
  an epoch `-reset`, *and* retained coverage for the `RateLimit-*` fallback and the
  `{detail}`/`detail[]` branches (kept, not pruned); `memories.patch()` happy/error
  paths once the live response shape is captured.
- **Versioning** — next cut is **`0.4.0`**, a *normal additive* pre-1.0 minor (per
  `RELEASING.md`): it carries `memories.patch()` (if probed), the A3 bug fix, and
  the spec corrections. **No breaking change** — the auth default is unchanged.
- **ADR-001 linkage** — add a Related-Decisions / Revision-History *pointer* to
  this ADR in ADR-001 (no body rewrite).

Every change here is additive, a bug fix, or spec/doc-corrective — there is **no
breaking change**. The A3/`patch()` code changes must pass `typecheck → test →
build`; spec-only and doc-only edits skip the code pre-commit gate.

## Validation

We will know this was the right call if:

- **The corrected spec matches a re-probe.** Re-running the card-2syddu probe
  against `api.production.xtrace.ai` after the spec edits finds no contradiction:
  the error envelope reads `{error:{…}}`, rate-limit headers are `x-ratelimit-*`,
  and `-reset` parses as a future epoch second.
- **`RateLimitSnapshot` populates in production.** After the `parseRateLimit` fix,
  a live 200 yields a defined snapshot with `limit`/`remaining`/`reset` from the
  `x-ratelimit-*` headers — proving the A3 capability now fires (it never did
  before).
- **The shared-bucket finding holds on re-test.** A live re-probe confirms
  `remaining` decrements across both `Bearer` and `x-api-key` calls (shared
  `(org_id, key_hash)` bucket) with no scheme-based `limit` difference once past the
  first call — i.e. the withdrawn 10× claim stays withdrawn and the documented
  shared-bucket note is accurate.
- **The org-mutation preconditions are met before `patch()` ships.** *Blocking
  precondition:* the implementation phase must (i) confirm it holds org-mutation
  authority (a tenant/memory it may create *and* delete), then (ii) using a
  **throwaway test memory** capture the live PATCH happy-path — its status code and
  whether it returns the updated `Memory` — and (iii) capture a real **429**'s
  envelope and headers (the read-only probe could not force one against the live
  bucket and did not mutate the org). `memories.patch()` return-type design and any
  429-specific snapshot/error handling are blocked on those captures. If either
  authority or the happy-path capture is unavailable, ship the spec correction
  (A4a) only and defer the method. If the captured shape differs from what the
  design doc assumes, the design doc — not this ADR — is revised.
- **Revisit trigger.** If a future deployment or server revision is observed
  emitting `{detail}` or `RateLimit-*` (the shapes we corrected away from), if the
  uncaptured 429 envelope turns out to differ from `{error:{…}}`, or if a per-scheme
  rate bucket is ever genuinely observed (re-opening the A2 question), reopen: the
  single-deployment / thin-observation assumption (Negative #1) would no longer
  hold.

## Related Decisions

- **ADR-001** (superseded in part, affirmed in part): A1, A3, and A4 dispositions
  are superseded by this ADR on live evidence; A2's `Bearer` default is **affirmed**
  — the controlled re-probe vindicated ADR-001's conservative choice. ADR-001's
  A5 (`metadata`), its no-regression *principle*, and its drift-direction framing
  remain valid. ADR-001's Validation section *predicted* this reopen.
- **ADR-002** (type-surface source of truth): unaffected, but `memories.patch()`
  adds a method to the hand-authored `src/types.ts` surface ADR-002 governs;
  the new request/response types follow ADR-002's source-of-truth rule.
- **gitban card 2syddu** (live-verification spike): the evidence base — raw 401/
  404/422 bodies (n=1 each), `x-ratelimit-*` header capture, the PATCH 422
  `empty_patch` observation, and the controlled auth re-probe (n=8, order reversed)
  that overturned the initial 10× reading — all captured 2026-06-15 against
  `api.production.xtrace.ai`.

## References

- gitban card **2syddu** — "LIVE VERIFICATION RESULTS (2026-06-15)": raw error
  bodies (n=1 per class), rate-limit header capture, PATCH falsification, and the
  auth re-probe (n=8) establishing the shared `(org_id, key_hash)` bucket.
- `spec/memory.json` — "Error envelope" / "Response headers" sections; auth
  security schemes + `(org_id, key_hash)` bucketing; PATCH
  `/v1/memories/{memory_id}` operation (≈ L113) and `UpdateRequest` schema.
- `src/http.ts` — `parseRateLimit` (reads `RateLimit-*`, L156-169); `defaultHttpConfig`
  (`authMode` default — **unchanged**, L176-192); auth-header selection (L58-62).
- `src/errors.ts` — `parseErrorBody` multi-envelope precedence (L75-92).
- `RELEASING.md` — pre-1.0 versioning: breaking changes bump the minor (L51-52).
- ADR-001 — `docs/adr/ADR-001-sdk-spec-reconciliation-policy.md` (Decision,
  Application table, Validation/revisit trigger).

---

## Revision History

| Date | Status | Notes |
|------|--------|-------|
| 2026-06-15 | Proposed | Initial nomination — supersede ADR-001's live-falsified A1/A3/A4 dispositions (and flip A2 default authMode → x-api-key) on the evidence of card 2syddu's live probe of api.production.xtrace.ai. |
| 2026-06-15 | Proposed (rev 2) | Adversarial-review fixes after a controlled auth re-probe (n=8, order reversed) **falsified the A2 10× premise** (the apparent gap was a first-call/cold-start artifact; the rate bucket is shared on `(org_id, key_hash)`). **A2 reversed:** keep `Bearer` default (no flip), document the shared bucket — eliminating the only breaking change; `0.4.0` becomes a normal additive minor (M1/M3, B2). **A4 split** into spec-correction-now (A4a) + probe-gated method (A4b) with an explicit org-mutation-authority precondition (S3). Evidence language softened to "observed (n=1 per error class)"; **429 envelope flagged as not captured / extrapolated**, so `{detail}`/`detail[]` and `RateLimit-*` fallbacks are **retained, not pruned** (S1/S2/M1). A3 fix kept; added the `RateLimitSnapshot.reset` JSDoc redefinition note (delta→epoch, doc-only) (M2). |
