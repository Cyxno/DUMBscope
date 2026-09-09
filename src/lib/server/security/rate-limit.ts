/**
 * Small in-memory sliding-window rate limiter (per key).
 *
 * Used for login attempts, setup-code attempts and DUMB connection tests.
 * Single-process app by design, so memory is the right place for this.
 */
interface Bucket {
	hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
	allowed: boolean;
	retryAfterMs: number;
	remaining: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
	const now = Date.now();
	let bucket = buckets.get(key);
	if (!bucket) {
		bucket = { hits: [] };
		buckets.set(key, bucket);
	}
	bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
	if (bucket.hits.length >= limit) {
		const oldest = bucket.hits[0] ?? now;
		return { allowed: false, retryAfterMs: windowMs - (now - oldest), remaining: 0 };
	}
	bucket.hits.push(now);
	return { allowed: true, retryAfterMs: 0, remaining: limit - bucket.hits.length };
}

export function resetRateLimit(key: string): void {
	buckets.delete(key);
}

/** Periodic sweep to keep the map small; called from the hub's housekeeping. */
export function sweepRateLimits(windowMs: number): void {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
		if (bucket.hits.length === 0) buckets.delete(key);
	}
}
