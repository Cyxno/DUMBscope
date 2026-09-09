/**
 * Capability detection against DUMB's `/process/capabilities`.
 *
 * DUMBscope degrades gracefully: every optional feature is gated behind a
 * capability flag and missing flags disable the UI path instead of crashing.
 */
export interface Capabilities {
	/** Raw flags from DUMB. */
	raw: Record<string, unknown>;
	has(flag: string): boolean;
	/** True when a capability list includes `value` (e.g. postgres service keys). */
	listIncludes(flag: string, value: string): boolean;
}

export function parseCapabilities(raw: Record<string, unknown> | null): Capabilities {
	const data = raw ?? {};
	return {
		raw: data,
		has(flag: string) {
			return data[flag] === true;
		},
		listIncludes(flag: string, value: string) {
			const list = data[flag];
			return Array.isArray(list) && list.includes(value);
		}
	};
}
