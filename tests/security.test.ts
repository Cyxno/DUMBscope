import { describe, expect, it } from 'vitest';
import {
	hashPassword,
	verifyPassword,
	encryptSecret,
	decryptSecret,
	generateSetupCode
} from '../src/lib/server/security/crypto';
import { validateDumbUrl, isSameOrigin } from '../src/lib/server/security/validation';
import { rateLimit, resetRateLimit } from '../src/lib/server/security/rate-limit';
import { Fingerprints } from '../src/lib/server/incidents/fingerprint';

describe('password hashing', () => {
	it('verifies the right password and rejects wrong ones', () => {
		const hash = hashPassword('correct horse battery');
		expect(verifyPassword('correct horse battery', hash)).toBe(true);
		expect(verifyPassword('wrong password', hash)).toBe(false);
		expect(verifyPassword('correct horse battery', 'garbage')).toBe(false);
	});

	it('produces unique salts', () => {
		expect(hashPassword('same')).not.toBe(hashPassword('same'));
	});
});

describe('secret encryption at rest', () => {
	it('round-trips and fails on tampering', () => {
		const envelope = encryptSecret('dumb-password-here');
		expect(envelope.startsWith('v1:')).toBe(true);
		expect(envelope).not.toContain('dumb-password-here');
		expect(decryptSecret(envelope)).toBe('dumb-password-here');

		const parts = envelope.split(':');
		const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${Buffer.from('evil').toString('base64')}`;
		expect(decryptSecret(tampered)).toBeNull();
	});
});

describe('setup codes', () => {
	it('generates transcribable codes with a dash', () => {
		const code = generateSetupCode();
		expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	});
});

describe('URL validation', () => {
	it('accepts and normalizes http(s) URLs', () => {
		expect(validateDumbUrl('http://192.168.1.2:3005').base).toBe('http://192.168.1.2:3005');
		expect(validateDumbUrl('https://dumb.example.com/').base).toBe('https://dumb.example.com');
		expect(validateDumbUrl('http://host:3005').wsBase).toBe('ws://host:3005');
	});

	it('rejects dangerous URLs', () => {
		expect(() => validateDumbUrl('file:///etc/passwd')).toThrow();
		expect(() => validateDumbUrl('http://user:pass@host:3005')).toThrow();
		expect(() => validateDumbUrl('http://host:3005/?x=1')).toThrow();
		expect(() => validateDumbUrl('not a url')).toThrow();
	});
});

describe('same-origin check', () => {
	const base = 'http://app.local:8091';

	function request(method: string, headers: Record<string, string>): Request {
		return new Request(base + '/api/settings', { method, headers });
	}

	it('allows same-origin mutations', () => {
		expect(isSameOrigin(request('POST', { origin: base }))).toBe(true);
		expect(isSameOrigin(request('POST', { referer: base + '/settings' }))).toBe(true);
	});

	it('rejects cross-origin mutations', () => {
		expect(isSameOrigin(request('POST', { origin: 'http://evil.example' }))).toBe(false);
		expect(isSameOrigin(request('DELETE', { referer: 'http://evil.example/x' }))).toBe(false);
	});

	it('allows no-origin GET requests but flags no-origin mutations per policy', () => {
		expect(isSameOrigin(request('GET', {}))).toBe(true);
		// Mutations without any browser context are allowed (API clients) — the
		// session cookie is still required by the route guard.
		expect(isSameOrigin(request('POST', {}))).toBe(true);
	});
});

describe('rate limiting', () => {
	it('blocks after the limit and reports retry time', () => {
		resetRateLimit('test-key');
		for (let i = 0; i < 5; i++) {
			expect(rateLimit('test-key', 5, 60_000).allowed).toBe(true);
		}
		const blocked = rateLimit('test-key', 5, 60_000);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterMs).toBeGreaterThan(0);
		resetRateLimit('test-key');
		expect(rateLimit('test-key', 5, 60_000).allowed).toBe(true);
	});
});

describe('incident fingerprints', () => {
	it('are stable per service and distinct across rules', () => {
		expect(Fingerprints.serviceUnhealthy('sonarr')).toBe(Fingerprints.serviceUnhealthy('sonarr'));
		expect(Fingerprints.serviceUnhealthy('sonarr')).not.toBe(
			Fingerprints.serviceUnhealthy('radarr')
		);
		expect(Fingerprints.serviceUnhealthy('sonarr')).not.toBe(
			Fingerprints.serviceDegraded('sonarr')
		);
	});
});
