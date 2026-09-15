/**
 * Service catalog contract tests (compatibility audit).
 *
 * Pins the compatibility contract between DUMB's process registry and
 * DUMBscope's service catalog, using the central registry fixture:
 *
 *   1. every service DUMB can report is recognised (no accidental generic)
 *   2. catalog ids/hrefs are unique and first-match never shadows a later
 *      specific entry (Seerr Sync vs Seerr, Traefik Proxy Admin vs Traefik)
 *   3. every catalog id has an icon (no accidental "unknown service" box)
 *   4. multi-instance services render once per instance with a qualifier and
 *      never collide
 *   5. health semantics never fake "healthy" for an unverified running process
 *   6. restart remediation is the single generic action via DUMB's own route
 *
 * The fixture mirrors a live DUMB v2.22.x registry (names/keys only).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	CATALOG,
	CATEGORY_ORDER,
	INTEGRATION_CAPABLE_IDS,
	matchCatalog
} from '../src/lib/shared/catalog';
import { buildPipelineModel, pipelineStatusFor } from '../src/lib/pipeline/model';
import type { TopologyNode } from '$lib/types';

const FIXTURE = JSON.parse(readFileSync('tests/fixtures/services/dumb-registry.json', 'utf8')) as {
	services: { config_key: string; name: string; process_name: string; enabled: boolean }[];
};

/** All pipeline services across flow stages, supporting and infrastructure. */
function allModelServices(model: ReturnType<typeof buildPipelineModel>) {
	return [
		...(model.infrastructure ?? []),
		...(model.stages ?? []),
		...(model.supporting ? [model.supporting] : [])
	].flatMap((entry) => ('services' in entry ? entry.services : [entry]));
}

function discoveredNodes(): TopologyNode[] {
	return FIXTURE.services.map((service) => ({
		key: service.config_key,
		name: service.name,
		known: matchCatalog(service.name, service.config_key) !== null,
		category: matchCatalog(service.name, service.config_key)?.category ?? 'auxiliary',
		health: service.enabled ? ('healthy' as const) : ('unknown' as const),
		runState: service.enabled ? ('running' as const) : ('stopped' as const)
	}));
}

describe('catalog integrity (§8/§65)', () => {
	it('has unique catalog ids', () => {
		const ids = CATALOG.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('uses only known pipeline categories', () => {
		for (const entry of CATALOG) {
			expect(CATEGORY_ORDER).toContain(entry.category);
		}
	});

	it('has an icon mapping for every catalog id (no accidental unknown box)', () => {
		const iconSource = readFileSync('src/lib/components/ServiceIcon.svelte', 'utf8');
		const missing = CATALOG.filter(
			(entry) => !iconSource.includes(`'${entry.id}':`) && !iconSource.includes(`${entry.id}:`)
		);
		expect(missing.map((entry) => entry.id)).toEqual([]);
	});

	it('every service in the DUMB registry fixture is recognised', () => {
		const unrecognised = FIXTURE.services.filter(
			(service) => matchCatalog(service.name, service.config_key) === null
		);
		expect(unrecognised.map((service) => service.process_name)).toEqual([]);
	});

	it('first-match order never shadows a specific entry (Seerr Sync, Traefik Proxy Admin)', () => {
		expect(matchCatalog('seerr_sync', 'seerr_sync')?.id).toBe('seerr-sync');
		expect(matchCatalog('Seerr Sync', 'seerr_sync')?.id).toBe('seerr-sync');
		expect(matchCatalog('traefik_proxy_admin', 'traefik_proxy_admin')?.id).toBe(
			'traefik-proxy-admin'
		);
		expect(matchCatalog('traefik', 'traefik')?.id).toBe('traefik');
		expect(matchCatalog('Jellyseerr', 'jellyseerr')?.id).toBe('seerr');
	});
});

describe('multi-instance behaviour (§12)', () => {
	it('qualifies non-default instances with their instance name', () => {
		const model = buildPipelineModel({
			nodes: discoveredNodes(),
			managedKeys: FIXTURE.services
				.filter((service) => service.enabled)
				.map((service) => service.config_key)
		});
		const services = allModelServices(model);
		const radarr4k = services.find((service) => service.key === 'radarr instances 4K');
		expect(radarr4k?.name).toBe('Radarr');
		expect(radarr4k?.instanceLabel).toBe('4K');
		// Both Radarr instances share the canonical name: each gets a distinct
		// qualifier so they can never collide in the UI.
		const radarrDefault = services.find((s) => s.key === 'radarr');
		expect(radarrDefault?.instanceLabel).toBeDefined();
		const labels = services
			.filter((service) => service.name === 'Radarr')
			.map((service) => service.instanceLabel);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('keeps a lone default instance unqualified', () => {
		const nodes = discoveredNodes().filter((node) => node.key === 'radarr');
		const model = buildPipelineModel({ nodes, managedKeys: nodes.map((node) => node.key) });
		const services = allModelServices(model);
		expect(services).toHaveLength(1);
		expect(services[0]!.name).toBe('Radarr');
		expect(services[0]!.instanceLabel).toBeNull();
	});

	it('renders two sonarr instances without name collision (both qualified)', () => {
		const nodes = discoveredNodes().filter((node) => node.key.startsWith('sonarr'));
		const model = buildPipelineModel({ nodes });
		const sonarrs = allModelServices(model).filter((service) => service.key.startsWith('sonarr'));
		expect(sonarrs).toHaveLength(2);
		const labels = sonarrs.map((service) => `${service.name} [${service.instanceLabel ?? ''}]`);
		expect(new Set(labels).size).toBe(2);
	});
});

describe('honest health semantics (§11)', () => {
	it('never reports healthy for a running process without a health report', () => {
		const status = pipelineStatusFor({ health: 'unknown', runState: 'running' });
		expect(status).toBe('running'); // "Running (unverified)" — never healthy
	});

	it('stopped and never-reported both map to offline, not healthy', () => {
		expect(pipelineStatusFor({ health: 'unknown', runState: 'stopped' })).toBe('offline');
		expect(pipelineStatusFor({ health: 'unknown', runState: 'stopped-unknown' })).toBe('offline');
	});

	it('a real health report maps to its semantic status', () => {
		expect(pipelineStatusFor({ health: 'healthy', runState: 'running' })).toBe('healthy');
		expect(pipelineStatusFor({ health: 'unhealthy', runState: 'running' })).toBe('critical');
		expect(pipelineStatusFor({ health: 'degraded', runState: 'running' })).toBe('degraded');
	});
});

describe('disabled services (§11/§13)', () => {
	it('disabled services are not part of the managed live hero count', () => {
		const enabledKeys = FIXTURE.services
			.filter((service) => service.enabled)
			.map((service) => service.config_key);
		const model = buildPipelineModel({ nodes: discoveredNodes(), managedKeys: enabledKeys });
		const disabled = allModelServices(model).filter((service) => !service.managed);
		for (const service of disabled) {
			expect(service.status === 'healthy').toBe(false);
		}
	});
});

describe('deep integration scope (§14/§18)', () => {
	it('claims deep integration only for adapters that exist', () => {
		// These are the only ids with a native adapter in the integrations layer.
		expect([...INTEGRATION_CAPABLE_IDS].sort()).toEqual(
			['plex', 'prowlarr', 'radarr', 'seerr', 'sonarr', 'tautulli'].sort()
		);
		// Library managers without an adapter must not claim library support.
		expect(INTEGRATION_CAPABLE_IDS.has('lidarr')).toBe(false);
		expect(INTEGRATION_CAPABLE_IDS.has('whisparr')).toBe(false);
	});

	it('restart remediation is the single generic action kind (§15)', () => {
		// Remediation deliberately exposes DUMB's own restart route only.
		const remediationSource = readFileSync('src/lib/server/reliability/remediation.ts', 'utf8');
		expect(remediationSource).toContain("ALLOWED_KINDS = new Set(['restart-managed-service'])");
	});
});
