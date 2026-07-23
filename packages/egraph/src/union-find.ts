/**
 * Union-find with path compression + union by rank for e-class leaders.
 */
export class UnionFind {
  private parent = new Map<number, number>();
  private rank = new Map<number, number>();

  makeSet(id: number): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  find(id: number): number {
    this.makeSet(id);
    let p = this.parent.get(id)!;
    if (p !== id) {
      p = this.find(p);
      this.parent.set(id, p);
    }
    return p;
  }

  /** Returns true if a merge happened. */
  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) [ra, rb] = [rb, ra];
    this.parent.set(rb, ra);
    if (rankA === rankB) this.rank.set(ra, rankA + 1);
    return true;
  }

  same(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}
