/**
 * Sliding-window counter per key (client address). Used twice: login failures (5 per 15 minutes)
 * and general API traffic (300 per 5 minutes). In memory: one server process.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => this.now() - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** True when the key has used up its allowance (does not count this call). */
  limited(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  hit(key: string): void {
    this.hits.set(key, [...this.recent(key), this.now()]);
  }

  /** Counts this call; returns false when over the limit. */
  take(key: string): boolean {
    if (this.limited(key)) return false;
    this.hit(key);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
