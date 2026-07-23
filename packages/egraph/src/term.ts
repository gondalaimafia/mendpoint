/**
 * Terms, patterns, and pretty-printing for e-graph work.
 *
 * Terms are trees of operators applied to child terms.
 * Patterns allow ?variables for e-matching.
 */

export type Term =
  | { kind: "var"; name: string }
  | { kind: "app"; op: string; children: Term[] }
  | { kind: "lit"; value: string | number | boolean };

export type Pattern = Term; // vars act as pattern variables

export function v(name: string): Term {
  return { kind: "var", name };
}

export function app(op: string, ...children: Term[]): Term {
  return { kind: "app", op, children };
}

export function lit(value: string | number | boolean): Term {
  return { kind: "lit", value };
}

/** Sugar: symbol with no children */
export function sym(name: string): Term {
  return app(name);
}

export function termKey(t: Term): string {
  if (t.kind === "var") return `?${t.name}`;
  if (t.kind === "lit") return JSON.stringify(t.value);
  return `(${t.op} ${t.children.map(termKey).join(" ")})`;
}

export function pretty(t: Term): string {
  if (t.kind === "var") return `?${t.name}`;
  if (t.kind === "lit") return String(t.value);
  if (!t.children.length) return t.op;
  return `${t.op}(${t.children.map(pretty).join(", ")})`;
}

export type Subst = Record<string, Term>;

export function applySubst(t: Term, subst: Subst): Term {
  if (t.kind === "var") {
    return subst[t.name] ? applySubst(subst[t.name]!, subst) : t;
  }
  if (t.kind === "lit") return t;
  return {
    kind: "app",
    op: t.op,
    children: t.children.map((c) => applySubst(c, subst)),
  };
}

/** Ground term? (no free vars) */
export function isGround(t: Term): boolean {
  if (t.kind === "var") return false;
  if (t.kind === "lit") return true;
  return t.children.every(isGround);
}
