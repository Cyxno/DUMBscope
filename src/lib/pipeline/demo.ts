/**
 * QA demo overrides: `?demo=failure` and `?demo=stale` let QA environments
 * render the incident and disconnect stories read-only. Pure presentation:
 * no persistence, no incident writes, no service mutations, no DUMB calls.
 *
 * Production-safe by default — overrides are ignored unless the deployment
 * opts in explicitly with PUBLIC_QA_DEMOS=1 (QA/e2e environments only).
 */
import { env } from '$env/dynamic/public';

export type PipelineDemo = 'failure' | 'stale' | null;

const QA_DEMOS_ENABLED = env.PUBLIC_QA_DEMOS === '1';

export function pipelineDemoFromUrl(url: URL, enabled: boolean = QA_DEMOS_ENABLED): PipelineDemo {
	if (!enabled) return null;
	const value = url.searchParams.get('demo');
	return value === 'failure' || value === 'stale' ? value : null;
}
