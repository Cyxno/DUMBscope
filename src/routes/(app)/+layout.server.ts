import { redirect } from '@sveltejs/kit';
import { getSettings } from '$lib/server/config/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(302, '/login');
	}
	const settings = getSettings();
	return {
		user: locals.user,
		prefs: {
			theme: settings.theme,
			accent: settings.accent,
			reducedMotion: settings.reducedMotion
		}
	};
};
