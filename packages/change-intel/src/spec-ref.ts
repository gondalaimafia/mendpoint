/**
 * OpenAPI `$ref` resolution for structural diffing.
 *
 * The differ compares the *effective* top-level properties of request/response
 * schemas. Real specs hide those schemas behind `$ref` (and behind `allOf` /
 * `oneOf` / `anyOf` composition), so a differ that never dereferences sees an
 * empty schema and silently reports "no change". This module dereferences
 * local refs against the document that owns them and flattens composition,
 * while refusing remote refs and bounding cycles so a recursive schema can
 * never hang or overflow the stack.
 *
 * Nothing here fetches the network: remote/external refs are recorded as
 * unresolved, never followed.
 */

export type Json = Record<string, unknown>;

export type SpecRefIssueKind =
  | "external_ref"
  | "unresolvable_ref"
  | "cycle_bounded";

export interface SpecRefIssue {
  kind: SpecRefIssueKind;
  /** The raw `$ref` string that could not be fully resolved. */
  ref: string;
  detail: string;
}

/**
 * Whether every `$ref` reached during a diff resolved cleanly. When `complete`
 * is false the diff is partial and callers must not treat it as exhaustive.
 */
export interface SpecResolutionReport {
  complete: boolean;
  issues: SpecRefIssue[];
}

/**
 * Depth cap on ref/composition chains. Self-referential and mutually recursive
 * schemas are stopped earlier by per-path ref tracking; this is the backstop
 * for pathological non-ref nesting so flattening always terminates.
 */
export const MAX_REF_DEPTH = 64;

export interface FlattenedSchema {
  /** Effective top-level property name -> raw (undereferenced) property schema. */
  props: Map<string, Json>;
  /** Effective set of required top-level property names. */
  required: Set<string>;
}

export function asObj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function isExternalRef(ref: string): boolean {
  // Anything that is not a local JSON pointer into this document is remote:
  // absolute URLs and other-file refs (`schemas.json#/...`) both qualify.
  return !ref.startsWith("#/");
}

function decodePointerToken(token: string): string {
  // RFC 6901 unescaping: ~1 -> "/", ~0 -> "~".
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * A resolver bound to a single root document. It accumulates resolution issues
 * as it dereferences, so a caller can inspect `issues` after diffing.
 */
export class SchemaResolver {
  readonly issues: SpecRefIssue[] = [];

  constructor(private readonly root: Json) {}

  private record(issue: SpecRefIssue): void {
    // De-duplicate identical issues so a repeated ref does not spam the report.
    if (
      !this.issues.some(
        (existing) => existing.kind === issue.kind && existing.ref === issue.ref,
      )
    ) {
      this.issues.push(issue);
    }
  }

  /** Resolve a local JSON pointer to its target node, or undefined. */
  private resolvePointer(ref: string): unknown {
    const tokens = ref.slice(2).split("/").map(decodePointerToken);
    let node: unknown = this.root;
    for (const token of tokens) {
      if (node === null || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[token];
      if (node === undefined) return undefined;
    }
    return node;
  }

  /**
   * Dereference a single node one level: if it is a `$ref`, return the
   * referenced node (following chains); otherwise return it unchanged. Used for
   * `requestBody` / `response` wrappers that may themselves be refs (e.g.
   * `#/components/requestBodies/...`). Unresolvable and external refs are
   * recorded and yield `{}`.
   */
  deref(node: unknown): unknown {
    const seen = new Set<string>();
    let current = node;
    for (let depth = 0; depth <= MAX_REF_DEPTH; depth++) {
      const obj = asObj(current);
      const ref = obj.$ref;
      if (typeof ref !== "string") return current;
      if (isExternalRef(ref)) {
        this.record({
          kind: "external_ref",
          ref,
          detail: `Refused to fetch remote $ref ${ref}; resolution left partial.`,
        });
        return {};
      }
      if (seen.has(ref)) {
        this.record({
          kind: "cycle_bounded",
          ref,
          detail: `Cyclic $ref chain through ${ref} was bounded, not fully expanded.`,
        });
        return {};
      }
      seen.add(ref);
      const target = this.resolvePointer(ref);
      if (target === undefined) {
        this.record({
          kind: "unresolvable_ref",
          ref,
          detail: `Local $ref ${ref} did not resolve to any node.`,
        });
        return {};
      }
      current = target;
    }
    this.record({
      kind: "cycle_bounded",
      ref: "<deref>",
      detail: `Reference chain exceeded depth ${MAX_REF_DEPTH}; resolution bounded.`,
    });
    return {};
  }

  /**
   * Flatten a schema to its effective top-level properties, following `$ref`
   * and merging `allOf` / `oneOf` / `anyOf`. Composition is unioned so that a
   * field carried through any branch is never lost (conservative: prefer
   * surfacing an ambiguous field over dropping it).
   */
  properties(schema: unknown): FlattenedSchema {
    const out: FlattenedSchema = { props: new Map(), required: new Set() };
    this.collect(schema, new Set<string>(), 0, out);
    return out;
  }

  private collect(
    node: unknown,
    seenRefs: Set<string>,
    depth: number,
    out: FlattenedSchema,
  ): void {
    if (depth > MAX_REF_DEPTH) {
      this.record({
        kind: "cycle_bounded",
        ref: "<schema>",
        detail: `Schema nesting exceeded depth ${MAX_REF_DEPTH}; flattening bounded.`,
      });
      return;
    }

    const s = asObj(node);

    const ref = s.$ref;
    if (typeof ref === "string") {
      if (isExternalRef(ref)) {
        this.record({
          kind: "external_ref",
          ref,
          detail: `Refused to fetch remote $ref ${ref}; resolution left partial.`,
        });
        return;
      }
      if (seenRefs.has(ref)) {
        this.record({
          kind: "cycle_bounded",
          ref,
          detail: `Cyclic $ref chain through ${ref} was bounded, not fully expanded.`,
        });
        return;
      }
      const target = this.resolvePointer(ref);
      if (target === undefined) {
        this.record({
          kind: "unresolvable_ref",
          ref,
          detail: `Local $ref ${ref} did not resolve to any node.`,
        });
        return;
      }
      const nextSeen = new Set(seenRefs);
      nextSeen.add(ref);
      this.collect(target, nextSeen, depth + 1, out);
      return;
    }

    // Direct properties.
    const props = asObj(s.properties);
    for (const [key, value] of Object.entries(props)) {
      out.props.set(key, asObj(value));
    }
    if (Array.isArray(s.required)) {
      for (const r of s.required) {
        if (typeof r === "string") out.required.add(r);
      }
    }

    // Composition. allOf is a conjunction (all constraints hold), so unioning
    // its members is exact. oneOf/anyOf are disjunctions; unioning is the
    // conservative choice — it surfaces every field any branch could carry.
    for (const key of ["allOf", "oneOf", "anyOf"] as const) {
      const members = s[key];
      if (Array.isArray(members)) {
        for (const member of members) {
          this.collect(member, seenRefs, depth + 1, out);
        }
      }
    }
  }
}

/** Merge per-spec resolver issues into a single report for a diff. */
export function buildResolutionReport(
  ...resolvers: SchemaResolver[]
): SpecResolutionReport {
  const issues: SpecRefIssue[] = [];
  for (const resolver of resolvers) {
    for (const issue of resolver.issues) {
      if (
        !issues.some((e) => e.kind === issue.kind && e.ref === issue.ref)
      ) {
        issues.push(issue);
      }
    }
  }
  return { complete: issues.length === 0, issues };
}

/** Stable structural equality for raw JSON schema fragments. */
export function schemaDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => schemaDeepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao).sort();
    const bKeys = Object.keys(bo).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) => schemaDeepEqual(ao[k], bo[k]));
  }
  return false;
}
