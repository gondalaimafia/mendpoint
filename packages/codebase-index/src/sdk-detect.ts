/**
 * Provider-driven SDK-call detection.
 *
 * The scanner must not carry provider-specific receiver or method names as
 * literals — that only ever satisfies our own fixtures (`acme`, `stripe`,
 * `charges`, `customers`) and returns nothing for a real customer calling
 * `twilio.messages.create(...)` or `plaid.accounts.get(...)`.
 *
 * Instead, detection learns the receivers, method paths, and field names of the
 * provider *under analysis* from an {@link SdkDetectionContext} (derived from the
 * change's Impactable Surfaces / OpenAPI spec). A call matched against that known
 * surface is `provider_surface`; a call recognized only by the provider-agnostic
 * fallback heuristic is `general_heuristic`. The two are labelled distinctly so
 * downstream confidence never conflates a guess with a known-surface match.
 *
 * When no provider context is available the fallback still emits `sdk_call`
 * usages (marked `general_heuristic`), so the absence of a spec degrades
 * confidence rather than silently producing zero results.
 */

/** How an `sdk_call` (or `field_token`) usage was recognized. */
export type SdkDetection = "provider_surface" | "general_heuristic";

/**
 * Provider surface signals used to drive detection. Callers build this from the
 * change under analysis (surfaces / OpenAPI spec / vendor tokens) rather than
 * from a literal in the scanner.
 */
export type SdkDetectionContext = Readonly<{
  /** Receiver identifiers tied to the provider: slug tokens, resource names, dotted-token heads. */
  receivers: readonly string[];
  /** Dotted method paths on the provider surface, e.g. "charges.create", "messages.create". */
  methodPaths: readonly string[];
  /** Single method / operation names, e.g. "getObject", "create", "list". */
  methods: readonly string[];
  /** Field / property names drawn from the provider spec surfaces. */
  fields: readonly string[];
  /** Import specifiers / package-name fragments identifying the provider package. */
  importHints: readonly string[];
}>;

/** Resolved, lowercased sets for fast per-line matching. */
export type SdkMatchSets = Readonly<{
  receivers: ReadonlySet<string>;
  methodPaths: ReadonlySet<string>;
  methods: ReadonlySet<string>;
  fields: ReadonlySet<string>;
  importHints: readonly string[];
  /** True when at least one provider signal is present. */
  hasProvider: boolean;
}>;

/**
 * Language builtins / test globals whose member calls (`console.log`,
 * `JSON.parse`, `expect(x).toBe`) are never provider SDK calls. This is generic
 * noise reduction for the provider-agnostic fallback, not provider-specific
 * knowledge; provider-matched calls bypass it.
 */
const HEURISTIC_STOPLIST: ReadonlySet<string> = new Set([
  "console",
  "json",
  "math",
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "promise",
  "date",
  "map",
  "set",
  "process",
  "window",
  "document",
  "require",
  "module",
  "exports",
  "describe",
  "it",
  "test",
  "expect",
  "vi",
  "jest",
  "beforeeach",
  "aftereach",
  "beforeall",
  "afterall",
]);

const EMPTY_SETS: SdkMatchSets = Object.freeze({
  receivers: new Set<string>(),
  methodPaths: new Set<string>(),
  methods: new Set<string>(),
  fields: new Set<string>(),
  importHints: [],
  hasProvider: false,
});

/** Resolve a context (or absence of one) into lowercased match sets. */
export function resolveSdkContext(ctx?: SdkDetectionContext | null): SdkMatchSets {
  if (!ctx) return EMPTY_SETS;
  const lower = (xs: readonly string[]) =>
    new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const receivers = lower(ctx.receivers);
  const methodPaths = lower(ctx.methodPaths);
  const methods = lower(ctx.methods);
  const fields = lower(ctx.fields);
  const importHints = [...lower(ctx.importHints)];
  const hasProvider =
    receivers.size > 0 || methodPaths.size > 0 || methods.size > 0 || fields.size > 0;
  return Object.freeze({ receivers, methodPaths, methods, fields, importHints, hasProvider });
}

function moduleMatchesProvider(spec: string, importHints: readonly string[]): boolean {
  const s = spec.toLowerCase();
  return importHints.some(
    (h) => h.length >= 3 && (s === h || s.endsWith(`/${h}`) || s.includes(h)),
  );
}

function collectJsBindings(clause: string, out: Set<string>): void {
  // `X`, `X, { a, b as c }`, `{ a as b }`, `* as ns`
  for (const m of clause.matchAll(/\*\s+as\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]!.toLowerCase());
  const braced = clause.match(/\{([^}]*)\}/);
  if (braced) {
    for (const part of braced[1]!.split(",")) {
      const seg = part.trim().split(/\s+as\s+/);
      const name = (seg[1] ?? seg[0])?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name.toLowerCase());
    }
  }
  const def = clause.replace(/\{[^}]*\}/g, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, "");
  for (const part of def.split(",")) {
    const name = part.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name.toLowerCase());
  }
}

/**
 * Import resolution: binding names bound to a module imported from the provider's
 * package. A binding proven to originate from the provider package is a far
 * stronger receiver hint than a name guess, so these receivers are trusted for
 * that file even when the identifier is aliased (e.g. `import { Client as sms }`).
 */
export function providerBindingsForFile(
  text: string,
  language: string,
  importHints: readonly string[],
): Set<string> {
  const bindings = new Set<string>();
  if (!importHints.length) return bindings;

  if (language === "python") {
    for (const m of text.matchAll(
      /^\s*import\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z0-9_]+))?/gm,
    )) {
      if (!moduleMatchesProvider(m[1]!, importHints)) continue;
      bindings.add((m[2] ?? m[1]!.split(".")[0]!).toLowerCase());
    }
    for (const m of text.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/gm)) {
      if (!moduleMatchesProvider(m[1]!, importHints)) continue;
      for (const part of m[2]!.split(",")) {
        const seg = part.trim().split(/\s+as\s+/);
        const name = (seg[1] ?? seg[0])?.trim();
        if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) bindings.add(name.toLowerCase());
      }
    }
    return bindings;
  }

  for (const m of text.matchAll(/import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!moduleMatchesProvider(m[2]!, importHints)) continue;
    collectJsBindings(m[1]!, bindings);
  }
  for (const m of text.matchAll(
    /(?:const|let|var)\s+(.+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    if (!moduleMatchesProvider(m[2]!, importHints)) continue;
    collectJsBindings(m[1]!, bindings);
  }
  return bindings;
}

/**
 * Classify a member-access chain (e.g. `client.charges.create`) against the
 * provider surface. Returns null when it is not SDK-call-like at all.
 */
export function classifyMemberChain(
  chain: string,
  sets: SdkMatchSets,
  fileReceivers: ReadonlySet<string>,
): SdkDetection | null {
  const lc = chain.toLowerCase();
  const segs = lc.split(".");
  if (segs.length < 2) return null;
  const head = segs[0]!;
  const providerMatch =
    sets.receivers.has(head) ||
    fileReceivers.has(head) ||
    segs.slice(1).some((s) => sets.receivers.has(s)) ||
    (sets.methodPaths.size > 0 && [...sets.methodPaths].some((mp) => lc.includes(mp)));
  if (providerMatch) return "provider_surface";
  if (HEURISTIC_STOPLIST.has(head)) return null;
  return "general_heuristic";
}

/**
 * Classify a call callee that may be a bare identifier or a dotted chain
 * (used by the TypeScript front-end). Bare identifiers are only accepted when
 * they match a known provider method/field/receiver — an unqualified call with
 * no provider match is ordinary control flow, not an SDK call.
 */
export function classifyCallee(
  callee: string,
  sets: SdkMatchSets,
  fileReceivers: ReadonlySet<string>,
): SdkDetection | null {
  if (callee.includes(".")) return classifyMemberChain(callee, sets, fileReceivers);
  const lc = callee.toLowerCase();
  if (sets.methods.has(lc) || sets.fields.has(lc) || sets.receivers.has(lc)) {
    return "provider_surface";
  }
  return null;
}

/**
 * Classify a property/field name. Spec fields (when available) are the
 * authoritative signal; absent a spec, fall back to a provider-agnostic
 * structural heuristic (multi-word snake_case identifiers) at lower confidence.
 */
export function classifyField(name: string, sets: SdkMatchSets): SdkDetection | null {
  const lc = name.toLowerCase();
  if (sets.fields.has(lc)) return "provider_surface";
  if (sets.fields.size > 0) return null; // spec-driven: only spec fields count as provider matches
  if (name.includes("_") && name.length >= 3) return "general_heuristic";
  return null;
}
