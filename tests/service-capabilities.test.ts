/**
 * Support matrix drift guard (§64/§65): the machine-readable capabilities
 * table in src/lib/shared/service-capabilities.ts is the source of truth for
 * docs/COMPATIBILITY.md. These tests fail when:
 *   - a capability references a service that is not in the catalog,
 *   - ids duplicate,
 *   - a real/contract claim is made without evidence rules being plausible,
 *   - the generated markdown table no longer matches the committed docs.
 *
 * Re-generate the docs table with `pnpm gen:compatibility` after intentional
 * capability changes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATALOG, INTEGRATION_CAPABLE_IDS } from '../src/lib/shared/catalog';
import {
	SERVICE_CAPABILITIES,
	type ServiceCapability
} from '../src/lib/shared/service-capabilities';

const MATRIX_HEADER =
	'| Service | Discovery | Basic monitoring | Operational | Deep integration | Remediation | Contract tested | Real tested |';
const BEGIN = '<!-- BEGIN GENERATED COMPATIBILITY TABLE -->';
const END = '<!-- END GENERATED COMPATIBILITY TABLE -->';

function symbol(value: boolean): string {
	return value ? '✅' : '—';
}

export function renderMatrixRows(capabilities: ServiceCapability[]): string[] {
	return capabilities.map(
		(capability) =>
			`| ${capability.displayName} | ${symbol(capability.discovery)} | ${symbol(
				capability.basicMonitoring
			)} | ${symbol(capability.operationalMonitoring)} | ${symbol(
				capability.deepIntegration
			)} | ${symbol(capability.remediation)} | ${symbol(
				capability.contractTested
			)} | ${symbol(capability.realTested)} |`
	);
}

function generatedBlock(capabilities: ServiceCapability[]): string {
	return [
		BEGIN,
		MATRIX_HEADER,
		'|---|---|---|---|---|---|---|---|',
		...renderMatrixRows(capabilities),
		END
	].join('\n');
}

describe('service capabilities integrity (§64/§65)', () => {
	it('references only known catalog ids, uniquely', () => {
		const catalogIds = new Set(CATALOG.map((entry) => entry.id));
		const ids = SERVICE_CAPABILITIES.map((capability) => capability.id);
		expect(new Set(ids).size).toBe(ids.length);
		const unknown = ids.filter((id) => !catalogIds.has(id));
		expect(unknown).toEqual([]);
		// Every catalog service is covered — the matrix is complete.
		const capabilityIds = new Set(ids);
		const uncovered = CATALOG.filter((entry) => !capabilityIds.has(entry.id));
		expect(uncovered.map((entry) => entry.id)).toEqual([]);
	});

	it('never claims real-tested without contract-tested (evidence ordering)', () => {
		for (const capability of SERVICE_CAPABILITIES) {
			if (capability.realTested) expect(capability.contractTested).toBe(true);
		}
	});

	it('never claims deep integration outside the deep-integration adapter set', () => {
		// Deep integration = native API/domain data (library, subtitles).
		// Sonarr/Radarr have the library browsers; Bazarr the subtitles browser.
		// Prowlarr/Plex/Seerr/Tautulli have health pollers (operational only).
		for (const capability of SERVICE_CAPABILITIES) {
			if (capability.deepIntegration) {
				expect(INTEGRATION_CAPABLE_IDS.has(capability.id) || capability.id === 'bazarr').toBe(true);
			}
		}
	});

	it('docs/COMPATIBILITY.md table matches the generated matrix exactly', () => {
		const docs = readFileSync('docs/COMPATIBILITY.md', 'utf8');
		const begin = docs.indexOf(BEGIN);
		const end = docs.indexOf(END);
		expect(
			begin,
			'docs/COMPATIBILITY.md is missing the generated-table markers'
		).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(begin);
		const committed = docs.slice(begin, end + END.length);
		expect(committed).toBe(generatedBlock(SERVICE_CAPABILITIES));
	});
});
