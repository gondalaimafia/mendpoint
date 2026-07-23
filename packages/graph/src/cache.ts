/**
 * Small TTL LRU for expensive graph builds (call graphs / product projections).
 */
type Entry<T> = { value: T; expires: number };

export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();

  constructor(
    private maxSize = 32,
    private ttlMs = 30_000,
  ) {}

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU order
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.maxSize) {
      const first = this.map.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export const callGraphCache = new TtlCache<unknown>(16, 60_000);
export const productGraphCache = new TtlCache<unknown>(8, 15_000);
export const changeGraphCache = new TtlCache<unknown>(24, 20_000);
