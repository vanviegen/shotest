import * as fs from 'fs';
import * as path from 'path';
import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';
import { testName, testTitle } from './manifest.js';

/**
 * The reporter of the `playwright test --list` the review runs (see
 * listTests in review.ts): writes the names of all tests there are to
 * SHOTEST_LIST_FILE, as a JSON array.
 */
export default class ListReporter implements Reporter {
    onBegin(_config: FullConfig, suite: Suite): void {
        const names = suite.allTests().map((test) => testName({
            file: path.relative(process.cwd(), test.location.file),
            title: testTitle(test.titlePath(), test.parent.project()?.name ?? '', test.location.file),
        }));
        fs.writeFileSync(process.env.SHOTEST_LIST_FILE!, JSON.stringify(names));
    }

    printsToStdio(): boolean {
        return false;
    }
}
