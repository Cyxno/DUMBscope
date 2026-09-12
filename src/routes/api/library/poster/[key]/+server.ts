/**
 * Poster image proxy (§7/§63/§64): serves artwork for known library item ids
 * only — never an arbitrary-URL or open proxy (§63). The upstream API key
 * stays server-side; the browser authenticates with its normal session cookie
 * (§126). Guards: content-type validation, size cap, timeout, bounded
 * in-memory cache and ETag-based revalidation (§64/§102/§103).
 */
import { jsonError } from '$lib/server/security/validation';
import { posterInfo } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

const KEY_PATTERN = /^(sonarr-series|radarr-movie)-\d+$/;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_IMAGES = 80;
const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';

interface CachedImage {
	buffer: ArrayBuffer;
	contentType: string;
	etag: string;
}

const imageCache = new Map<string, CachedImage>();

function cacheImage(key: string, image: CachedImage): void {
	if (imageCache.size >= MAX_CACHED_IMAGES) {
		const oldest = imageCache.keys().next().value;
		if (oldest) imageCache.delete(oldest);
	}
	imageCache.set(key, image);
}

function etagFor(key: string, version: string | null): string {
	return `"poster-${key}-${version ?? '0'}"`;
}

export const GET: RequestHandler = async ({ params, request }) => {
	ensureIntegrationsUp();
	const key = params.key ?? '';
	if (!KEY_PATTERN.test(key)) {
		return jsonError('Invalid image id', 400);
	}
	const info = posterInfo(key);
	if (!info) {
		// Unknown or evicted item: the client falls back to the initials tile (§65).
		return jsonError('Poster not available', 404);
	}

	const etag = etagFor(key, info.version);
	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch && ifNoneMatch.includes(etag)) {
		return new Response(null, {
			status: 304,
			headers: { etag, 'cache-control': CACHE_CONTROL }
		});
	}

	const cached = imageCache.get(key);
	if (cached && cached.etag === etag) {
		return new Response(cached.buffer, {
			headers: {
				'content-type': cached.contentType,
				'cache-control': CACHE_CONTROL,
				etag
			}
		});
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	let upstream: Response;
	try {
		upstream = await fetch(info.baseUrl + info.path, {
			headers: { 'X-Api-Key': info.apiKey, accept: 'image/*' },
			signal: controller.signal
		});
	} catch {
		return jsonError('Poster upstream failed', 502);
	} finally {
		clearTimeout(timer);
	}

	const contentType = upstream.headers.get('content-type') ?? '';
	if (!upstream.ok || !contentType.startsWith('image/')) {
		return jsonError('Poster not available', 404);
	}
	const declaredSize = Number(upstream.headers.get('content-length') ?? 0);
	if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
		return jsonError('Poster too large', 413);
	}

	const buffer = await upstream.arrayBuffer();
	if (buffer.byteLength > MAX_IMAGE_BYTES) {
		return jsonError('Poster too large', 413);
	}

	cacheImage(key, { buffer, contentType, etag });
	return new Response(buffer, {
		headers: {
			'content-type': contentType,
			'cache-control': CACHE_CONTROL,
			etag
		}
	});
};
