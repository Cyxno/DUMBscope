/**
 * Process shutdown wiring.
 *
 * adapter-node emits `sveltekit:shutdown` once the HTTP server has closed.
 * Without explicit cleanup the telemetry hub's reconnect timers and the 10s
 * housekeeper interval keep the event loop alive, so the process never exits
 * on SIGTERM and container runtimes fall back to SIGKILL after their grace
 * period.
 */
import { resetHub } from '$lib/server/telemetry/hub';
import { closeDb } from '$lib/server/database/db';

let installed = false;

export function installShutdownHooks(): void {
	if (installed) return;
	installed = true;

	process.on('sveltekit:shutdown', () => {
		try {
			// No-op when the hub was never started; stops streams + housekeeper.
			resetHub();
		} catch {
			// Never let cleanup errors block the exit.
		}
		try {
			closeDb();
		} catch {
			// Idem.
		}
		// Failsafe: exit even if an unknown handle still pins the event loop.
		setTimeout(() => process.exit(0), 1_000).unref();
	});
}
