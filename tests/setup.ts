import { beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Every test run gets an isolated config dir so the SQLite state never leaks.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-test-'));
process.env.DUMBSCOPE_CONFIG_DIR = tmp;

beforeAll(() => {
	process.env.DUMBSCOPE_CONFIG_DIR = tmp;
});

afterAll(() => {
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		// best effort
	}
});
