// See https://svelte.dev/docs/kit/types#app.d.ts
import type { SessionUser } from '$lib/server/security/sessions';

declare global {
	namespace App {
		interface Locals {
			user: SessionUser | null;
			sessionToken: string | undefined;
		}
	}
}

export {};
