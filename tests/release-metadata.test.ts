/**
 * Release metadata validation: scripts/validate-release-metadata.sh must tie
 * the tag, package.json version, CHANGELOG entry and the mainline together
 * before anything is built or published.
 *
 * Regression context: the runtime reports package.json's version (vite
 * define), so a tag/package drift would publish an image tagged 0.9.4 that
 * reports 0.9.3 — exactly the identity confusion the provenance work exists
 * to prevent. These tests run the real script on throwaway git repos.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('scripts/validate-release-metadata.sh');

function git(dir: string, ...args: string[]): string {
	const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
	return res.stdout ?? '';
}

/** CI always exposes GITHUB_REF_NAME; tests must not depend on it. */
const CLEAN_ENV: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (key !== 'GITHUB_REF_NAME' && key !== 'RELEASE_TAG' && value !== undefined) {
		CLEAN_ENV[key] = value;
	}
}

function initRepo(version: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-release-metadata-'));
	git(dir, 'init');
	git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
	git(dir, 'config', 'user.email', 'meta@test.local');
	git(dir, 'config', 'user.name', 'Release Metadata Test');
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({ name: 'fixture', version }, null, '\t') + '\n'
	);
	fs.writeFileSync(
		path.join(dir, 'CHANGELOG.md'),
		`# Changelog\n\n## [${version}] — today\n\n- x\n`
	);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-m', `release: ${version}`, '--quiet');
	git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD').trim());
	return dir;
}

function tagAndCheckout(dir: string, tag: string): void {
	git(dir, 'tag', '-a', tag, '-m', tag);
	git(dir, 'checkout', tag, '--quiet'); // detached HEAD at the tag, like CI
}

function runValidate(dir: string, env: Record<string, string>): { status: number; output: string } {
	const res = spawnSync('bash', [SCRIPT], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...CLEAN_ENV, ...env }
	});
	return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('release metadata validation', () => {
	it('passes a fully consistent tag/version/changelog/mainline release', () => {
		const dir = initRepo('0.9.4');
		tagAndCheckout(dir, 'v0.9.4');
		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v0.9.4' });
		expect(status).toBe(0);
		expect(output).toContain('tag=v0.9.4 version=0.9.4');
		expect(output).toContain('release-metadata: PASS');
	});

	it('fails when the package version drifts from the tag', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-release-metadata-'));
		git(dir, 'init');
		git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
		git(dir, 'config', 'user.email', 'meta@test.local');
		git(dir, 'config', 'user.name', 'Release Metadata Test');
		// The tagged commit itself carries the drift: package says 0.9.5 while
		// the changelog and tag say 0.9.4.
		fs.writeFileSync(
			path.join(dir, 'package.json'),
			JSON.stringify({ name: 'fixture', version: '0.9.5' }, null, '\t') + '\n'
		);
		fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [0.9.4] — today\n\n- x\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'release: 0.9.4', '--quiet');
		git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD').trim());
		tagAndCheckout(dir, 'v0.9.4');

		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v0.9.4' });
		expect(status).toBe(1);
		expect(output).toContain("'0.9.5' != tag version '0.9.4'");
	});

	it('fails when the changelog has no entry for the version', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-release-metadata-'));
		git(dir, 'init');
		git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
		git(dir, 'config', 'user.email', 'meta@test.local');
		git(dir, 'config', 'user.name', 'Release Metadata Test');
		// The tagged commit's changelog was never updated for this version.
		fs.writeFileSync(
			path.join(dir, 'package.json'),
			JSON.stringify({ name: 'fixture', version: '0.9.4' }, null, '\t') + '\n'
		);
		fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [0.9.3] — old\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'release: 0.9.4', '--quiet');
		git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD').trim());
		tagAndCheckout(dir, 'v0.9.4');

		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v0.9.4' });
		expect(status).toBe(1);
		expect(output).toContain("CHANGELOG.md has no '## [0.9.4]' entry");
	});

	it('fails a non-semantic tag name', () => {
		const dir = initRepo('0.9.4');
		tagAndCheckout(dir, 'v0.9');
		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v0.9' });
		expect(status).toBe(1);
		expect(output).toContain('not a semantic release tag');
	});

	it('fails when the tag does not point at the checked-out commit', () => {
		const dir = initRepo('0.9.4');
		tagAndCheckout(dir, 'v0.9.4');
		fs.writeFileSync(path.join(dir, 'after.txt'), 'later\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'later work', '--quiet');

		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v0.9.4' });
		expect(status).toBe(1);
		expect(output).toContain('points at');
		expect(output).toContain('but the release checkout is');
	});

	it('fails a tag cut outside the mainline', () => {
		const dir = initRepo('0.9.4');
		const mainTip = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'checkout', '-b', 'side/work', '--quiet');
		fs.writeFileSync(path.join(dir, 'side.txt'), 'side\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'side', '--quiet');
		git(dir, 'tag', '-a', 'v0.9.4', '-m', 'side release');
		git(dir, 'checkout', 'v0.9.4', '--quiet');
		publishAsOriginMain(dir, mainTip);

		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v0.9.4' });
		expect(status).toBe(1);
		expect(output).toContain('not reachable from origin/main');
	});

	it('fails closed when no tag is provided', () => {
		const dir = initRepo('0.9.4');
		const { status, output } = runValidate(dir, {});
		expect(status).toBe(2);
		expect(output).toContain('no tag to validate');
	});

	it('fails closed when the tag does not exist', () => {
		const dir = initRepo('0.9.4');
		const { status, output } = runValidate(dir, { RELEASE_TAG: 'v9.9.9' });
		expect(status).toBe(2);
		expect(output).toContain("tag 'v9.9.9' does not resolve");
	});
});

function publishAsOriginMain(dir: string, sha: string): void {
	git(dir, 'update-ref', 'refs/remotes/origin/main', sha);
}
