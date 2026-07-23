/**
 * E-Graph core: e-nodes, e-classes, hash-cons, union-find, deferred rebuilding.
 *
 * Inspired by egg (Willsey et al.) — rebuild amortizes congruence restoration
 * across equality-saturation phases.
 */
import { UnionFind } from "./union-find.js";
import {
  type Term,
  type Pattern,
  type Subst,
  applySubst,
  isGround,
  pretty,
  termKey,
} from "./term.js";

export type EClassId = number;

export type ENode = {
  op: string;
  /** Children are canonical e-class ids */
  children: EClassId[];
};

export type EClassAnalysis = {
  /** Arbitrary lattice facts (e.g. constant, cost lower bound, touchesBreakingField) */
  facts: Record<string, unknown>;
};

export type EClassData = {
  id: EClassId;
  nodes: ENode[];
  analysis: EClassAnalysis;
};

function enodeKey(n: ENode): string {
  return `${n.op}(${n.children.join(",")})`;
}

function canonicalizeNode(n: ENode, uf: UnionFind): ENode {
  return {
    op: n.op,
    children: n.children.map((c) => uf.find(c)),
  };
}

export type EGraphStats = {
  classes: number;
  nodes: number;
  rebuilds: number;
  unions: number;
};

/**
 * Equality graph with congruence closure via deferred rebuild.
 */
export class EGraph {
  private uf = new UnionFind();
  private nextId = 1;
  /** hash-cons: enodeKey → e-class id (may need find()) */
  private memo = new Map<string, EClassId>();
  /** leader id → class data */
  private classes = new Map<EClassId, EClassData>();
  /** parent map for congruence: child class → parents that contain it */
  private parents = new Map<EClassId, Set<string>>();
  /** Worklist of class ids that may need congruence repair */
  private dirty = new Set<EClassId>();
  private rebuildCount = 0;
  private unionCount = 0;

  stats(): EGraphStats {
    let nodes = 0;
    for (const c of this.classes.values()) nodes += c.nodes.length;
    return {
      classes: this.classes.size,
      nodes,
      rebuilds: this.rebuildCount,
      unions: this.unionCount,
    };
  }

  private ensureClass(id: EClassId): EClassData {
    const leader = this.uf.find(id);
    let data = this.classes.get(leader);
    if (!data) {
      data = { id: leader, nodes: [], analysis: { facts: {} } };
      this.classes.set(leader, data);
    }
    return data;
  }

  /** Add a ground term; returns its e-class id. */
  add(term: Term): EClassId {
    if (!isGround(term)) {
      throw new Error(`add() requires ground term, got ${pretty(term)}`);
    }
    return this.addRec(term);
  }

  private addRec(term: Term): EClassId {
    if (term.kind === "var") throw new Error("unexpected var");
    if (term.kind === "lit") {
      return this.addNode({ op: `lit:${JSON.stringify(term.value)}`, children: [] });
    }
    const childIds = term.children.map((c) => this.addRec(c));
    return this.addNode({ op: term.op, children: childIds });
  }

  addNode(raw: ENode): EClassId {
    const node = canonicalizeNode(raw, this.uf);
    const key = enodeKey(node);
    const existing = this.memo.get(key);
    if (existing !== undefined) return this.uf.find(existing);

    const id = this.nextId++;
    this.uf.makeSet(id);
    const data: EClassData = {
      id,
      nodes: [node],
      analysis: { facts: {} },
    };
    this.classes.set(id, data);
    this.memo.set(key, id);

    for (const ch of node.children) {
      const leader = this.uf.find(ch);
      if (!this.parents.has(leader)) this.parents.set(leader, new Set());
      this.parents.get(leader)!.add(key);
    }
    this.dirty.add(id);
    return id;
  }

  find(id: EClassId): EClassId {
    return this.uf.find(id);
  }

  /** Union two e-classes (record equivalence). Congruence deferred until rebuild(). */
  union(a: EClassId, b: EClassId): boolean {
    const ra = this.uf.find(a);
    const rb = this.uf.find(b);
    if (ra === rb) return false;

    // Prefer keeping ra as leader when ranks equal — handled in UF
    const merged = this.uf.union(ra, rb);
    if (!merged) return false;
    this.unionCount++;

    const leader = this.uf.find(ra);
    const other = leader === this.uf.find(ra) ? (this.uf.find(rb) === leader ? (ra === leader ? rb : ra) : rb) : rb;
    // After union, leader is uf.find(ra)
    const L = this.uf.find(a);
    const dead = L === this.uf.find(ra) ? (ra === L ? rb : ra) : ra;
    // Simpler approach: merge class data from both pre-find roots
    this.mergeClassData(ra, rb);

    this.dirty.add(L);
    // Mark parents of both
    for (const root of [ra, rb]) {
      for (const pk of this.parents.get(root) ?? []) {
        // parent enodes will be rechecked in rebuild
        void pk;
      }
      const pset = this.parents.get(root);
      if (pset) {
        if (!this.parents.has(L)) this.parents.set(L, new Set());
        for (const x of pset) this.parents.get(L)!.add(x);
      }
    }
    void dead;
    void other;
    return true;
  }

  private mergeClassData(a: EClassId, b: EClassId): void {
    const la = this.uf.find(a);
    // After union, both find to same leader
    const leader = this.uf.find(a);
    const da = this.classes.get(a) ?? this.classes.get(la);
    const db = this.classes.get(b) ?? this.classes.get(this.uf.find(b));
    // Collect from any map entries that find to leader
    const nodes: ENode[] = [];
    const facts: Record<string, unknown> = {};
    const toDelete: EClassId[] = [];
    for (const [id, data] of this.classes) {
      if (this.uf.find(id) === leader) {
        nodes.push(...data.nodes);
        Object.assign(facts, data.analysis.facts);
        if (id !== leader) toDelete.push(id);
      }
    }
    for (const id of toDelete) this.classes.delete(id);
    // Also merge da/db if orphaned
    void da;
    void db;
    this.classes.set(leader, {
      id: leader,
      nodes: dedupeNodes(nodes, this.uf),
      analysis: { facts },
    });
  }

  equiv(a: EClassId, b: EClassId): boolean {
    return this.uf.same(a, b);
  }

  setFact(id: EClassId, key: string, value: unknown): void {
    const data = this.ensureClass(id);
    data.analysis.facts[key] = value;
  }

  getFact<T = unknown>(id: EClassId, key: string): T | undefined {
    return this.ensureClass(id).analysis.facts[key] as T | undefined;
  }

  /**
   * Restore congruence: process dirty classes, re-hash-cons e-nodes,
   * merge newly congruent classes until fixpoint.
   */
  rebuild(): void {
    this.rebuildCount++;
    const work = [...this.dirty];
    this.dirty.clear();

    while (work.length) {
      const id = this.uf.find(work.pop()!);
      const data = this.classes.get(id);
      if (!data) continue;

      // Re-canonicalize and re-memo nodes
      const fresh: ENode[] = [];
      for (const n of data.nodes) {
        const cn = canonicalizeNode(n, this.uf);
        const key = enodeKey(cn);
        const existing = this.memo.get(key);
        if (existing !== undefined && this.uf.find(existing) !== id) {
          // Congruence discovered: same structure in another class
          this.union(id, existing);
          work.push(this.uf.find(id), this.uf.find(existing));
        } else {
          this.memo.set(key, id);
          fresh.push(cn);
        }
      }
      data.nodes = dedupeNodes(fresh, this.uf);

      // Check parents for congruence
      for (const pkey of this.parents.get(id) ?? []) {
        // pkey is enode key — if memo maps elsewhere after canonicalize, union
        const parts = pkey.match(/^(.+)\((.*)\)$/);
        if (!parts) continue;
        const op = parts[1]!;
        const kids = parts[2] === "" ? [] : parts[2]!.split(",").map(Number);
        const cn = canonicalizeNode({ op, children: kids }, this.uf);
        const nk = enodeKey(cn);
        const m = this.memo.get(nk);
        const old = this.memo.get(pkey);
        if (m !== undefined && old !== undefined && this.uf.find(m) !== this.uf.find(old)) {
          this.union(m, old);
          work.push(this.uf.find(m));
        }
        if (nk !== pkey) {
          this.memo.set(nk, this.memo.get(pkey) ?? id);
        }
      }
    }

    // Compact class map to leaders only
    this.compactClasses();
  }

  private compactClasses(): void {
    const next = new Map<EClassId, EClassData>();
    for (const [id, data] of this.classes) {
      const L = this.uf.find(id);
      const existing = next.get(L);
      if (!existing) {
        next.set(L, {
          id: L,
          nodes: dedupeNodes(data.nodes.map((n) => canonicalizeNode(n, this.uf)), this.uf),
          analysis: data.analysis,
        });
      } else {
        existing.nodes = dedupeNodes(
          [...existing.nodes, ...data.nodes].map((n) => canonicalizeNode(n, this.uf)),
          this.uf,
        );
        Object.assign(existing.analysis.facts, data.analysis.facts);
      }
    }
    this.classes = next;

    // Rebuild memo from classes
    this.memo.clear();
    for (const [id, data] of this.classes) {
      for (const n of data.nodes) {
        this.memo.set(enodeKey(n), id);
      }
    }
  }

  getClass(id: EClassId): EClassData | undefined {
    return this.classes.get(this.uf.find(id));
  }

  allClassIds(): EClassId[] {
    return [...this.classes.keys()];
  }

  /**
   * E-matching: find substitutions of pattern that map into the e-graph.
   * Returns list of { subst, eclass } for the root match class.
   */
  ematch(pattern: Pattern): Array<{ subst: Subst; eclass: EClassId }> {
    const results: Array<{ subst: Subst; eclass: EClassId }> = [];
    for (const id of this.allClassIds()) {
      for (const subst of this.matchInClass(pattern, id, {})) {
        results.push({ subst, eclass: id });
      }
    }
    return results;
  }

  private matchInClass(
    pattern: Pattern,
    eclass: EClassId,
    subst: Subst,
  ): Subst[] {
    const L = this.uf.find(eclass);
    if (pattern.kind === "var") {
      const existing = subst[pattern.name];
      if (!existing) {
        // bind to a representative term of this class
        const rep = this.extractOne(L);
        return [{ ...subst, [pattern.name]: rep }];
      }
      // existing binding must be equivalent
      try {
        const eid = this.add(applySubst(existing, {}));
        if (this.equiv(eid, L)) return [subst];
      } catch {
        return [];
      }
      return [];
    }

    if (pattern.kind === "lit") {
      const key = enodeKey({ op: `lit:${JSON.stringify(pattern.value)}`, children: [] });
      const mid = this.memo.get(key);
      if (mid !== undefined && this.equiv(mid, L)) return [subst];
      // also scan class nodes
      const data = this.classes.get(L);
      if (data?.nodes.some((n) => n.op === `lit:${JSON.stringify(pattern.value)}`)) {
        return [subst];
      }
      return [];
    }

    // app pattern
    const data = this.classes.get(L);
    if (!data) return [];
    const out: Subst[] = [];
    for (const n of data.nodes) {
      if (n.op !== pattern.op || n.children.length !== pattern.children.length) continue;
      let frames: Subst[] = [subst];
      let ok = true;
      for (let i = 0; i < pattern.children.length; i++) {
        const next: Subst[] = [];
        for (const s of frames) {
          next.push(...this.matchInClass(pattern.children[i]!, n.children[i]!, s));
        }
        frames = next;
        if (!frames.length) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(...frames);
    }
    return out;
  }

  /** Extract a single representative term (smallest enode tree, greedy). */
  extractOne(eclass: EClassId): Term {
    const costs = new Map<EClassId, { cost: number; term: Term }>();
    const visiting = new Set<EClassId>();

    const extract = (id: EClassId): { cost: number; term: Term } => {
      const L = this.uf.find(id);
      if (costs.has(L)) return costs.get(L)!;
      if (visiting.has(L)) {
        // cycle — return placeholder
        return { cost: 1e9, term: { kind: "app", op: "⊥", children: [] } };
      }
      visiting.add(L);
      const data = this.classes.get(L);
      let best: { cost: number; term: Term } = {
        cost: 1e9,
        term: { kind: "app", op: "?", children: [] },
      };
      if (data) {
        for (const n of data.nodes) {
          if (n.op.startsWith("lit:")) {
            const raw = n.op.slice(4);
            let value: string | number | boolean;
            try {
              value = JSON.parse(raw) as string | number | boolean;
            } catch {
              value = raw;
            }
            const term: Term = { kind: "lit", value };
            const cost = 1;
            if (cost < best.cost) best = { cost, term };
            continue;
          }
          const kids = n.children.map((c) => extract(c));
          const cost = 1 + kids.reduce((s, k) => s + k.cost, 0);
          const term: Term = {
            kind: "app",
            op: n.op,
            children: kids.map((k) => k.term),
          };
          if (cost < best.cost) best = { cost, term };
        }
      }
      visiting.delete(L);
      costs.set(L, best);
      return best;
    };

    return extract(eclass).term;
  }

  /** Dump for debugging */
  debugClasses(): string {
    const lines: string[] = [];
    for (const [id, data] of this.classes) {
      const ns = data.nodes.map((n) => enodeKey(n)).join(" | ");
      lines.push(`c${id}: ${ns}`);
    }
    return lines.join("\n");
  }
}

function dedupeNodes(nodes: ENode[], uf: UnionFind): ENode[] {
  const seen = new Set<string>();
  const out: ENode[] = [];
  for (const n of nodes) {
    const cn = canonicalizeNode(n, uf);
    const k = enodeKey(cn);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(cn);
  }
  return out;
}

export { pretty, termKey, applySubst };
