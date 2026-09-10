/**
 * URL validation for integration connections (brief §68).
 *
 * Service URLs are admin-configured; LAN/self-hosted targets are the whole
 * point, so private addresses are fine — but schemes must be http(s), the
 * host must exist and no credentials-in-URL tricks are allowed.
 */
export function validateIntegrationUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error('Integration URL must be a valid URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Integration URL must use http:// or https://');
	}
	if (!url.hostname) throw new Error('Integration URL needs a host');
	if (url.username || url.password) {
		throw new Error('Put credentials in the API key field, not the URL');
	}
	// Normalize: no trailing slash, no query/fragment garbage.
	url.search = '';
	url.hash = '';
	return url.toString().replace(/\/+$/, '');
}
