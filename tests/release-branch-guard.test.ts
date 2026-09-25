/**
 * Release guard: scripts/check-release-branches.sh must block a release while
 * a fix/hardening/release-blocker branch carries commits that never reached
 * origin/main — and must stay silent for fully merged or allowlisted branches.
 *
 * Regression context (2026-09-25): v0.9.1/v0.9.2 were tagged from main without
 * the hardening/symlink-namespace-guard branch merged, which re-opened the
 * TV/Movies symlink incidents in production. These tests pin the guard's
 * contract on throwaway git repos, so no network and no real remotes involved.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('scripts/check-release-branches.sh');

function git(dir: string, ...args: string[]): string {
	const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
	if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
	return res.stdout ?? '';
}

function initRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-release-guard-'));
	git(dir, 'init');
	git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
	git(dir, 'config', 'user.email', 'guard@test.local');
	git(dir, 'config', 'user.name', 'Release Guard Test');
	commit(dir, 'base');
	return dir;
}

let fileSeq = 0;
function commit(dir: string, subject: string): string {
	fs.writeFileSync(path.join(dir, `file-${fileSeq++}.txt`), `${subject}\n`);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-m', subject, '--quiet');
	return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Publish a local commit as origin/<branch>, the way a clone's remote-tracking refs look. */
function publishAsOrigin(dir: string, branch: string, sha: string): void {
	git(dir, 'update-ref', `refs/remotes/origin/${branch}`, sha);
}

function runGuard(
	dir: string,
	env: Record<string, string> = {}
): { status: number; output: string } {
	const res = spawnSync('bash', [SCRIPT], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, ...env }
	});
	return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('release branch guard', () => {
	it('passes when a hardening branch is fully merged into main', () => {
		const dir = initRepo();
		const tip = commit(dir, 'hardening: real fix');
		publishAsOrigin(dir, 'hardening/merged', tip);
		publishAsOrigin(dir, 'main', tip); // ff-merged: main == branch tip

		const { status, output } = runGuard(dir);
		expect(status).toBe(0);
		expect(output).toContain('hardening/merged (fully merged');
		expect(output).toContain('release-guard summary: scanned=1 merged=1 ignored=0 blocking=0');
		expect(output).toContain('release-guard: PASS');
	});

	it('blocks with branch name, SHAs and subjects when a hardening branch is unmerged', () => {
		const dir = initRepo();
		const base = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'checkout', '-b', 'hardening/late-fix', '--quiet');
		const sha1 = commit(dir, 'fix(reliability): guard the namespace');
		const sha2 = commit(dir, 'fix(hub): retire stale findings');
		git(dir, 'checkout', 'main', '--quiet');
		publishAsOrigin(dir, 'hardening/late-fix', sha2);
		publishAsOrigin(dir, 'main', base); // main never received the branch

		const { status, output } = runGuard(dir);
		expect(status).toBe(1);
		expect(output).toContain('Branch: hardening/late-fix');
		expect(output).toContain(sha1.slice(0, 7));
		expect(output).toContain(sha2.slice(0, 7));
		expect(output).toContain('guard the namespace');
		expect(output).toContain('retire stale findings');
		expect(output).toContain('release-guard: BLOCKED');
	});

	it('passes an unmerged experimental branch that is on the allowlist', () => {
		const dir = initRepo();
		const base = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'checkout', '-b', 'fix/experiment', '--quiet');
		const sha = commit(dir, 'experiment: never ships from here');
		git(dir, 'checkout', 'main', '--quiet');
		publishAsOrigin(dir, 'fix/experiment', sha);
		publishAsOrigin(dir, 'main', base);

		const allowlist = path.join(os.tmpdir(), `allowlist-${fileSeq++}.txt`);
		fs.writeFileSync(allowlist, '# parked work\nfix/experiment\n');

		const { status, output } = runGuard(dir, { RELEASE_GUARD_ALLOWLIST: allowlist });
		expect(status).toBe(0);
		expect(output).toContain('fix/experiment (allowlisted');
		expect(output).toContain('release-guard: PASS');
	});

	it('supports allowlist globs for experimental namespaces', () => {
		const dir = initRepo();
		const base = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'checkout', '-b', 'release-blocker/parked', '--quiet');
		const sha = commit(dir, 'experiment: parked blocker');
		git(dir, 'checkout', 'main', '--quiet');
		publishAsOrigin(dir, 'release-blocker/parked', sha);
		publishAsOrigin(dir, 'main', base);

		const allowlist = path.join(os.tmpdir(), `allowlist-${fileSeq++}.txt`);
		fs.writeFileSync(allowlist, 'release-blocker/*   # glob entry\n');

		const { status, output } = runGuard(dir, { RELEASE_GUARD_ALLOWLIST: allowlist });
		expect(status).toBe(0);
		expect(output).toContain('release-blocker/parked (allowlisted');
	});

	it('reports only the unmerged branch in a mixed repo', () => {
		const dir = initRepo();

		// merged branch: never appears as a violation
		git(dir, 'checkout', '-b', 'fix/landed', '--quiet');
		const landed = commit(dir, 'fix: already landed');
		git(dir, 'checkout', 'main', '--quiet');
		git(dir, 'merge', '--ff-only', 'fix/landed', '--quiet');
		publishAsOrigin(dir, 'fix/landed', landed);

		// unmerged branch: the one violation
		git(dir, 'checkout', '-b', 'hardening/missing', '--quiet');
		const missing = commit(dir, 'fix(hardening): never merged');
		git(dir, 'checkout', 'main', '--quiet');
		publishAsOrigin(dir, 'hardening/missing', missing);
		publishAsOrigin(dir, 'main', git(dir, 'rev-parse', 'HEAD').trim());

		const { status, output } = runGuard(dir);
		expect(status).toBe(1);
		expect(output).toContain('fix/landed (fully merged');
		expect(output).toContain('Branch: hardening/missing');
		expect(output).toContain(missing.slice(0, 7));
		expect(output).not.toContain('Branch: fix/landed');
	});

	it('treats a missing baseline as a setup error, never as a pass', () => {
		const dir = initRepo();
		const { status, output } = runGuard(dir, { RELEASE_GUARD_BASELINE: 'origin/nonexistent' });
		expect(status).toBe(2);
		expect(output).toContain('SETUP ERROR');
	});

	it('blocks an unmerged fix branch and an unmerged release-blocker branch', () => {
		const dir = initRepo();
		const base = git(dir, 'rev-parse', 'HEAD').trim();

		git(dir, 'checkout', '-b', 'fix/urgent', '--quiet');
		const fixSha = commit(dir, 'fix: unmerged fix');
		git(dir, 'checkout', 'main', '--quiet');

		git(dir, 'checkout', '-b', 'release-blocker/ops', '--quiet');
		const blockerSha = commit(dir, 'release-blocker: unmerged ops fix');
		git(dir, 'checkout', 'main', '--quiet');

		publishAsOrigin(dir, 'fix/urgent', fixSha);
		publishAsOrigin(dir, 'release-blocker/ops', blockerSha);
		publishAsOrigin(dir, 'main', base);

		const { status, output } = runGuard(dir);
		expect(status).toBe(1);
		expect(output).toContain('Branch: fix/urgent');
		expect(output).toContain('Branch: release-blocker/ops');
		expect(output).toContain('release-guard summary: scanned=2 merged=0 ignored=0 blocking=2');
	});

	it('ignores irrelevant feature branches entirely', () => {
		const dir = initRepo();
		const base = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'checkout', '-b', 'feature/ui-rewrite', '--quiet');
		const sha = commit(dir, 'feature: speculative work, out of scope for the guard');
		git(dir, 'checkout', 'main', '--quiet');
		publishAsOrigin(dir, 'feature/ui-rewrite', sha);
		publishAsOrigin(dir, 'main', base);

		const { status, output } = runGuard(dir);
		expect(status).toBe(0);
		expect(output).not.toContain('feature/ui-rewrite');
		expect(output).toContain('release-guard summary: scanned=0 merged=0 ignored=0 blocking=0');
		expect(output).toContain('release-guard: PASS');
	});

	it('rejects a malformed allowlist entry instead of broadening the match', () => {
		const dir = initRepo();
		const base = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'checkout', '-b', 'fix/parked', '--quiet');
		const sha = commit(dir, 'fix: parked');
		git(dir, 'checkout', 'main', '--quiet');
		publishAsOrigin(dir, 'fix/parked', sha);
		publishAsOrigin(dir, 'main', base);

		const allowlist = path.join(os.tmpdir(), `allowlist-${fileSeq++}.txt`);
		// Whitespace would word-split into unrelated patterns — must be rejected.
		fs.writeFileSync(allowlist, 'fix/parked extra-token\n');

		const { status, output } = runGuard(dir, { RELEASE_GUARD_ALLOWLIST: allowlist });
		expect(status).toBe(2);
		expect(output).toContain('malformed allowlist entry');
	});

	it('fails closed on a shallow clone instead of passing on partial history', () => {
		const dir = initRepo();
		const tip = commit(dir, 'hardening: real fix');
		publishAsOrigin(dir, 'main', tip);

		const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-shallow-'));
		const shallow = path.join(parent, 'clone');
		git(parent, 'clone', '--depth', '1', `file://${dir}`, shallow, '--quiet');

		const { status, output } = runGuard(shallow);
		expect(status).toBe(2);
		expect(output).toContain('shallow clone cannot judge ancestry');
	});
});
