// Typed filter DSL builder (design B1 / KD-4).
//
// Emits the wire JSON the server's filter DSL expects for
// `SearchRequest.filters` (see spec/memory.json "Filter DSL"):
//   - per-field operators: $eq $ne $in $nin $exists $gt $gte $lt $lte $between
//   - a bare `null` value means "field is unset"
//   - boolean composition via the AND / OR / NOT keys
//   - top-level keys are implicit-AND'd
//
// The builder is **key-agnostic** by construction: it builds conditions over
// arbitrary field-name strings, not a fixed field enum. That is the deliberate
// resolution of the `metadata` tension (ADR-001 A5) — the SDK dropped the typed
// `metadata` field, but the server still filters on *any* indexed payload key,
// including customer metadata keys. A key-agnostic builder therefore filters
// entity axes (`user_id`, `agent_id`, …) and arbitrary metadata/payload keys
// identically, without reintroducing a typed `metadata` field.
//
// `Filter = Record<string, unknown>` (src/types.ts) stays as the raw escape
// hatch; every value this module emits is assignable to it.

import type { Filter } from "./types.js";

/** A value usable with the equality/range operators. */
export type Comparable = string | number | boolean;

/**
 * The operators available on a single field. Use {@link f.field} to put more
 * than one operator on the same field — e.g. a two-sided range is
 * `f.field('price', { $gt: 10, $lt: 100 })`, which keeps **both** operators.
 */
export interface FieldOps {
  $eq?: Comparable;
  $ne?: Comparable;
  $in?: Comparable[];
  $nin?: Comparable[];
  $exists?: boolean;
  $gt?: Comparable;
  $gte?: Comparable;
  $lt?: Comparable;
  $lte?: Comparable;
  /** Inclusive `[lo, hi]` range. */
  $between?: [Comparable, Comparable];
}

/**
 * One filter clause: a per-field condition (`{ field: ops }` or `{ field: null }`
 * for "unset"), or a boolean composition of clauses. Assignable to
 * {@link Filter} (`Record<string, unknown>`), so any clause can be passed
 * directly as `SearchRequest.filters`.
 */
export type Clause =
  | Record<string, Comparable | null | FieldOps>
  | { AND: Clause[] }
  | { OR: Clause[] }
  | { NOT: Clause };

/**
 * Typed, discoverable builder for the filter DSL. Build a clause and pass it as
 * `SearchRequest.filters`; the emitted object is the exact wire shape.
 *
 * The design forces every multi-operator-per-field condition through a single
 * {@link f.field} call (and makes {@link f.all} throw on a same-field collision)
 * so a silently-wrong range — two operators collapsing to one — is
 * unrepresentable.
 *
 * @example
 * // (agent_id == "bot") AND (0.5 <= score < 0.9) AND (plan in ["a","b"])
 * search({ query, filters: f.all(
 *   f.eq("agent_id", "bot"),
 *   f.field("score", { $gte: 0.5, $lt: 0.9 }),
 *   f.in("plan", ["a", "b"]),
 * )});
 */
export const f = {
  /**
   * Single-field condition carrying one or more operators. This is the ONLY way
   * to put multiple operators on one field, so a range is
   * `f.field('price', { $gt: 10, $lt: 100 })` — both operators kept. The ops
   * object AND its array-valued operators (`$in`/`$nin`/`$between`) are copied,
   * so mutating the caller's input afterwards can't corrupt the clause.
   */
  field: (name: string, ops: FieldOps): Clause => {
    const copy: FieldOps = { ...ops };
    // Deep-copy the array-typed operators — a shallow `{ ...ops }` would leave
    // these aliased to the caller's arrays, so a later `ops.$between[1] = …`
    // would mutate the already-built clause.
    if (Array.isArray(copy.$in)) copy.$in = [...copy.$in];
    if (Array.isArray(copy.$nin)) copy.$nin = [...copy.$nin];
    if (Array.isArray(copy.$between)) copy.$between = [copy.$between[0], copy.$between[1]];
    return { [name]: copy };
  },

  /** `field == v` (explicit equality; same as a bare value server-side). */
  eq: (field: string, v: Comparable): Clause => ({ [field]: { $eq: v } }),
  /** `field != v` AND field is set (SQL semantics). */
  ne: (field: string, v: Comparable): Clause => ({ [field]: { $ne: v } }),
  /** `field` is one-of `v`. */
  in: (field: string, v: Comparable[]): Clause => ({ [field]: { $in: [...v] } }),
  /** `field` is none-of `v` (MongoDB semantics — null/absent passes). */
  nin: (field: string, v: Comparable[]): Clause => ({ [field]: { $nin: [...v] } }),
  /** `$exists`: `true` (default) = field set, `false` = field unset. */
  exists: (field: string, v = true): Clause => ({ [field]: { $exists: v } }),
  /** Inclusive `[lo, hi]` range. */
  between: (field: string, lo: Comparable, hi: Comparable): Clause => ({
    [field]: { $between: [lo, hi] },
  }),
  /** `field` is unset — emits `{ field: null }` (null = unset, per spec). */
  isNull: (field: string): Clause => ({ [field]: null }),

  /** Boolean AND of clauses → `{ AND: [...] }`. */
  and: (...c: Clause[]): Clause => ({ AND: c }),
  /** Boolean OR of clauses → `{ OR: [...] }`. */
  or: (...c: Clause[]): Clause => ({ OR: c }),
  /** Boolean NOT of a clause → `{ NOT: <clause> }`. */
  not: (c: Clause): Clause => ({ NOT: c }),

  /**
   * Implicit-AND of clauses on DISTINCT fields, merged into one object (the
   * server implicit-ANDs top-level keys). Throws on a same-field collision
   * rather than silently dropping operators — combine a field's operators in a
   * single {@link f.field} call, or use {@link f.and} to AND two conditions on
   * the same field explicitly. Inputs are not mutated.
   */
  all: (...c: Clause[]): Filter => {
    const out: Record<string, unknown> = {};
    for (const clause of c) {
      for (const [k, v] of Object.entries(clause)) {
        if (k in out) {
          throw new Error(
            `filter: duplicate field "${k}" in f.all(); combine its operators in a ` +
              `single f.field("${k}", {...}), or use f.and(...) to AND them explicitly`,
          );
        }
        out[k] = v;
      }
    }
    return out;
  },
};
