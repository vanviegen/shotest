#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  startReviewServer,
  loadTestRecords,
  buildAlignEntries,
  hasVisualChanges,
  testId,
} from './review.js';
import { gcPoolFiles, hasLegacyAcceptedLayout, legacyAcceptedHint } from './manifest.js';

interface VisualSummary {
  passed: number;
  changed: number;
  unchanged: number;
  noScreenshots: number;
}

const require = createRequire(import.meta.url);

function getOutputDir(): string {
  return process.env.SHOTEST_OUTPUT_DIR || 'test-results';
}

function getAcceptedDir(): string {
  return process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted';
}

async function getVisualSummary(outputDir: string, acceptedDir: string): Promise<VisualSummary | null> {
  if (!existsSync(outputDir)) {
    return null;
  }

  if (hasLegacyAcceptedLayout(acceptedDir)) {
    console.warn('\nShoTest: ' + legacyAcceptedHint(acceptedDir));
    return null;
  }

  const acceptedByKey = new Map(loadTestRecords(acceptedDir).map((test) => [testId(test), test]));

  let passed = 0;
  let changed = 0;
  let unchanged = 0;
  let noScreenshots = 0;

  for (const record of loadTestRecords(outputDir)) {
    if (record.status !== 'passed') {
      continue;
    }

    if (record.steps.length === 0) {
      noScreenshots++;
      continue;
    }

    passed++;

    const currentEntries = buildAlignEntries(outputDir, record.steps);
    const acceptedEntries = buildAlignEntries(acceptedDir, acceptedByKey.get(testId(record))?.steps ?? []);
    if (await hasVisualChanges(acceptedEntries, currentEntries)) {
      changed++;
    } else {
      unchanged++;
    }
  }

  if (passed === 0 && noScreenshots === 0) {
    return null;
  }

  return { passed, changed, unchanged, noScreenshots };
}

async function printVisualSummary(): Promise<boolean> {
  const summary = await getVisualSummary(getOutputDir(), getAcceptedDir());

  if (!summary) {
    return false;
  }

  const noScreenshotsText = summary.noScreenshots > 0
    ? `, ${summary.noScreenshots} passed with no screenshots`
    : '';

  console.log(`\nShoTest visuals: ${summary.changed} changed, ${summary.unchanged} unchanged across ${summary.passed} passed test(s)${noScreenshotsText}`);
  if (summary.changed > 0) {
    console.log('Run "npx shotest review" to review and accept visual changes');
  }
  return summary.changed > 0;
}

function runGc(verbose: boolean): void {
  const acceptedDir = getAcceptedDir();
  const legacyAccepted = hasLegacyAcceptedLayout(acceptedDir);
  if (legacyAccepted && verbose) {
    // The post-test summary already hints at this when gc runs automatically.
    console.warn('ShoTest gc: ' + legacyAcceptedHint(acceptedDir));
  }
  const removedResults = gcPoolFiles(getOutputDir());
  const removedAccepted = legacyAccepted ? 0 : gcPoolFiles(acceptedDir);
  if (verbose || removedResults + removedAccepted > 0) {
    console.log(`ShoTest gc: removed ${removedResults} unreferenced file(s) from ${getOutputDir()}, ${removedAccepted} from ${acceptedDir}`);
  }
}

function runPlaywright(argv: string[]): number {
  const cliPath = require.resolve('@playwright/test/cli');
  const result = spawnSync(process.execPath, [cliPath, ...argv], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 0;
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  let failOnVisualChanges = false;

  if (argv.includes('--fail-on-visual-changes')) {
    failOnVisualChanges = true;
    argv = argv.filter((arg) => arg !== '--fail-on-visual-changes');
  }

  const firstArg = argv[0];

  if (firstArg === 'review') {
    await startReviewServer();
    return;
  }

  if (firstArg === 'gc') {
    runGc(true);
    return;
  }

  const status = runPlaywright(argv);

  if (firstArg === 'test') {
    const hasVisualChanges = await printVisualSummary();
    // A clean, unfiltered run has produced results for every test there is,
    // so anything the spec JSONs no longer reference is garbage. Extra
    // arguments could have filtered the run (a file, -g, --shard, ...), in
    // which case gc would see only a partial picture — skip it then.
    if (status === 0 && argv.length === 1) {
      runGc(false);
    }
    if (status === 0 && hasVisualChanges && failOnVisualChanges) {
      process.exit(1);
    }
  }

  process.exit(status);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
