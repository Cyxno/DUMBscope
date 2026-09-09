/**
 * Client-safe adapter summary: mirrors the server registry logic but only uses
 * shared catalog data (never imports server-only modules).
 */
import type { DiscoveredService, ServiceStatus } from '$lib/types';
import { matchCatalog } from '$lib/shared/catalog';

export function integrationRegistrySafeSummary(
	service: DiscoveredService,
	status: ServiceStatus | null
): Record<string, string> {
	const summary: Record<string, string> = {};
	if (service.version) summary['Version'] = service.version;
	if (service.repoUrl) summary['Project'] = service.repoUrl;
	if (service.updateStatus && service.updateStatus.status === 'update_available') {
		summary['Update'] =
			`${service.updateStatus.currentVersion ?? '?'} → ${service.updateStatus.availableVersion ?? '?'}`;
	}
	const entry = matchCatalog(service.name, service.key);
	void entry;
	void status;
	return summary;
}
