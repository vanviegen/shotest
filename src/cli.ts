#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, cacheResultsDir, pruneCache, restoreResult } from './cache.js';
import { listTests } from './list-reporter.js';
import { startReviewServer, testId } from './review.js';
import { sourceTreeHash } from './tree.js';
import {
  gcPoolFiles,
  hasLegacyAcceptedLayout,
  legacyAcceptedHint,
  loadTestRecords,
  migrateAcceptedDir,
  sameVisuals,
  type TestRecord,
} from './manifest.js';

interface Summary {
  passed: number;
  changed: number;
  unchanged: number;
  noScreenshots: number;
  failedTests: TestRecord[];
}

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getOutputDir(): string {
  return process.env.SHOTEST_OUTPUT_DIR || 'test-results';
}

function getAcceptedDir(): string {
  return process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted';
}

function getSummary(outputDir: string, acceptedDir: string): Summary | null {
  if (!existsSync(outputDir)) {
    return null;
  }

  if (hasLegacyAcceptedLayout(acceptedDir)) {
    console.warn('\nShoTest: ' + legacyAcceptedHint(acceptedDir));
    return null;
  }

  const acceptedByKey = new Map(loadTestRecords(acceptedDir).map((test) => [testId(test), test]));

  const summary: Summary = { passed: 0, changed: 0, unchanged: 0, noScreenshots: 0, failedTests: [] };
  let seen = 0;

  for (const record of loadTestRecords(outputDir)) {
    seen++;

    if (record.status === 'skipped') {
      continue;
    }

    if (record.status !== 'passed') {
      summary.failedTests.push(record);
      continue;
    }

    if (record.steps.length === 0) {
      summary.noScreenshots++;
      continue;
    }

    summary.passed++;

    if (sameVisuals(acceptedByKey.get(testId(record))?.steps ?? [], record.steps)) {
      summary.unchanged++;
    } else {
      summary.changed++;
    }
  }

  if (seen === 0) {
    return null;
  }

  return summary;
}

function printSummary(): Summary | null {
  const summary = getSummary(getOutputDir(), getAcceptedDir());

  if (!summary) {
    return null;
  }

  if (summary.failedTests.length > 0) {
    console.log(`\nShoTest: ${summary.failedTests.length} failed test(s):`);
    for (const test of summary.failedTests) {
      const source = test.errorSource ? ` at ${test.errorSource}` : '';
      console.log(`- ${test.file} › ${test.title} (${test.status}${source})`);
    }
  }

  if (summary.passed > 0 || summary.noScreenshots > 0) {
    const noScreenshotsText = summary.noScreenshots > 0
      ? `, ${summary.noScreenshots} passed with no screenshots`
      : '';

    console.log(`\nShoTest visuals: ${summary.changed} changed, ${summary.unchanged} unchanged across ${summary.passed} passed test(s)${noScreenshotsText}`);
    if (summary.changed > 0) {
      console.log('Run "npx shotest review" to review the visual changes');
    }
  }

  return summary;
}

// The explicit `shotest gc` sweeps both pools. Elsewhere each pool is swept
// at the moment it can have become garbage: test-results/ on every
// `shotest collect`, test-accepted/ whenever a review is applied.
function runGc(): void {
  const acceptedDir = getAcceptedDir();
  const legacyAccepted = hasLegacyAcceptedLayout(acceptedDir);
  if (legacyAccepted) {
    console.warn('ShoTest gc: ' + legacyAcceptedHint(acceptedDir));
  }
  const removedResults = gcPoolFiles(getOutputDir());
  const removedAccepted = legacyAccepted ? 0 : gcPoolFiles(acceptedDir);
  console.log(`ShoTest gc: removed ${removedResults} unreferenced file(s) from ${getOutputDir()}, ${removedAccepted} from ${acceptedDir}`);
}

// `shotest collect` turns results already on disk — from an earlier
// `shotest test`, or a `shotest-playwright` run in a Node-less environment —
// into a summary plus an exit code: 0 all good, 1 failed tests, 2 tests
// passed but visual changes await review. Also sweeps the results pool.
function runCollect(): number {
  const summary = printSummary();
  if (!summary) {
    // Missing results (or an unreadable 1.x layout) must not pass a gate.
    console.error(`ShoTest collect: no test results found in ${getOutputDir()}`);
    return 1;
  }

  const removed = gcPoolFiles(getOutputDir());
  if (removed > 0) {
    console.log(`ShoTest gc: removed ${removed} unreferenced file(s) from ${getOutputDir()}`);
  }

  if (summary.failedTests.length > 0) return 1;
  if (summary.changed > 0) return 2;
  return 0;
}

/**
 * What renders the tests `shotest test` runs, as the result cache knows it
 * (see cachedResultsDir in fixture.ts): the container image
 * bin/shotest-playwright picks, or for a native run SHOTEST_RENDERER, else
 * the installed Playwright.
 */
function renderer(noContainer: boolean): string {
  const version: string = require('@playwright/test/package.json').version;
  const containerized = !noContainer && process.platform !== 'win32' &&
    ['podman', 'docker'].some((runner) => spawnSync(runner, ['--version'], { stdio: 'ignore' }).status === 0);
  if (containerized) return process.env.SHOTEST_IMAGE || `mcr.microsoft.com/playwright:v${version}-noble`;
  return process.env.SHOTEST_RENDERER || `native-${version}`;
}

// `shotest restore [files]` puts the cached results of the tests in the given
// spec files (all, if none) into the results directory, as `shotest test`
// would on this source tree, and prints the files that still have a test to
// run: the ones a run needs.
function runRestore(files: string[], noContainer: boolean): void {
  const tree = sourceTreeHash([getOutputDir(), getAcceptedDir()]);
  const cached = tree && cacheResultsDir(cacheDir(), tree, renderer(noContainer));
  const toRun = new Set<string>();
  for (const test of listTests(files)) {
    if (!cached || !restoreResult(test, cached, getOutputDir())) toRun.add(test.file);
  }
  for (const file of toRun) console.log(file);
}

/**
 * Hand the arguments to the Playwright CLI via bin/shotest-playwright, which
 * owns the how: `test` runs go inside the pinned Playwright container image
 * when podman or docker is available (see the README's "Deterministic
 * screenshots" section), everything else — and `test` with --no-container —
 * runs natively. It is plain sh so Node-less environments can invoke it
 * directly; Windows has no sh, so there Playwright always runs natively.
 */
function runPlaywright(argv: string[], noContainer: boolean): number {
  const [command, args] = process.platform === 'win32'
    ? [process.execPath, [require.resolve('@playwright/test/cli'), ...argv]]
    : [path.join(packageRoot, 'bin', 'shotest-playwright'), noContainer ? [...argv, '--no-container'] : argv];

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  let noContainer = !!process.env.SHOTEST_NO_CONTAINER;

  if (argv.includes('--no-container')) {
    noContainer = true;
    argv = argv.filter((arg) => arg !== '--no-container');
  }
  if (argv[0] === 'test' && argv.includes('--all')) {
    process.env.SHOTEST_RUN_ALL = '1';
    argv = argv.filter((arg) => arg !== '--all');
  }

  const firstArg = argv[0];
  migrateAcceptedDir(getAcceptedDir());

  if (firstArg === 'review') {
    // Exits by itself once the review is applied or discarded, so that
    // waiting for the command to finish is a way to wait for a human.
    await startReviewServer();
    return;
  }

  if (firstArg === 'gc') {
    runGc();
    return;
  }

  if (firstArg === 'collect') {
    process.exit(runCollect());
  }

  if (firstArg === 'restore') {
    runRestore(argv.slice(1), noContainer);
    return;
  }

  // Everything else is Playwright's, `test` included: reporting on a test
  // run and gating on it is `shotest collect`'s job.
  if (firstArg !== 'test') process.exit(runPlaywright(argv, noContainer));

  // Tests that already passed on this source tree are skipped (unless
  // --all), their results coming from the cache, where those of the tests
  // that pass are kept for the next run.
  const cache = cacheDir();
  const tree = sourceTreeHash([getOutputDir(), getAcceptedDir()]);
  try {
    mkdirSync(cache, { recursive: true });
    if (tree) {
      process.env.SHOTEST_TREE = tree;
      process.env.SHOTEST_CACHE_DIR = cache;
    }
  } catch { } // nowhere to keep a cache (no writable home, say): every test runs
  const status = runPlaywright(argv, noContainer);
  pruneCache(cache);
  process.exit(status);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
