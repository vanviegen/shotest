import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';
import { testTitle, type TestIdentity } from './manifest.js';

/**
 * The reporter of the `playwright test --list` that listTests runs: writes
 * the identities of the tests listed to SHOTEST_LIST_FILE, as a JSON array.
 */
export default class ListReporter implements Reporter {
    onBegin(_config: FullConfig, suite: Suite): void {
        const tests: TestIdentity[] = suite.allTests().map((test) => ({
            file: path.relative(process.cwd(), test.location.file),
            title: testTitle(test.titlePath(), test.parent.project()?.name ?? '', test.location.file),
        }));
        fs.writeFileSync(process.env.SHOTEST_LIST_FILE!, JSON.stringify(tests));
    }

    printsToStdio(): boolean {
        return false;
    }
}

/**
 * The tests there are (in `files`, if given), as Playwright lists them with
 * the project's own config, natively: listing loads the spec files but runs
 * nothing. Throws with Playwright's complaint when it cannot list them.
 */
export function listTests(files: string[] = []): TestIdentity[] {
    const listFile = path.join(os.tmpdir(), `shotest-list-${process.pid}.json`);
    try {
        execFileSync(process.execPath, [
            createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', '--list', `--reporter=${fileURLToPath(import.meta.url)}`, ...files,
        ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SHOTEST_LIST_FILE: listFile } });
        return JSON.parse(fs.readFileSync(listFile, 'utf-8'));
    } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
        throw new Error(stderr || String(error));
    } finally {
        fs.rmSync(listFile, { force: true });
    }
}
