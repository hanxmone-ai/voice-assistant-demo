/**
 * Token bucket per client: [perMinute] requests a minute, refilled
 * continuously, with bursts up to the same number.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  /** Takes a token for [key]. Returns 0 when allowed, else the seconds to wait. */
  take(key: string): number {
    if (this.perMinute <= 0) return 0;
    const now = this.now();
    const rate = this.perMinute / 60000;
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.at) * rate);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 10000) this.prune(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / rate / 1000);
  }

  /** Forgets clients whose bucket is full again. */
  private prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * (this.perMinute / 60000) >= this.perMinute) this.buckets.delete(key);
    }
  }
}
