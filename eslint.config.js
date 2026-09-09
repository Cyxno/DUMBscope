import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'coverage/', 'node_modules/']
	},
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser
			}
		}
	},
	{
		// Runes modules (*.svelte.ts) need the Svelte-aware parser too.
		files: ['**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser,
				extraFileExtensions: ['.svelte']
			}
		}
	},
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
			// Static same-app routes; no i18n-prefixed routing to resolve.
			'svelte/no-navigation-without-resolve': 'off',
			// Local (non-escaped) Map/Set usage inside $derived is safe in runes mode.
			'svelte/prefer-svelte-reactivity': 'off'
		}
	}
);
