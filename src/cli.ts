#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startReviewServer } from './review.js';
import type { TestManifest } from './fixture.js';
import { areImagesEquivalent } from './visual-compare.js';

interface VisualSummary {
  passed: number;
  changed: number;
  unchanged: number;
  noScreenshots: number;
}

const require = createRequire(import.meta.url);

function loadManifest(manifestPath: string): TestManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as TestManifest;
  } catch {
    return null;
  }
}

async function getVisualSummary(outputDir: string, acceptedDir: string): Promise<VisualSummary | null> {
  if (!existsSync(outputDir)) {
    return null;
  }

  const testDirs = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let passed = 0;
  let changed = 0;
  let unchanged = 0;
  let noScreenshots = 0;

  for (const testName of testDirs) {
    const manifestPath = join(outputDir, testName, 'manifest.json');
    if (!existsSync(manifestPath)) {
      continue;
    }

    const manifest = loadManifest(manifestPath);
    if (!manifest || manifest.status !== 'passed') {
      continue;
    }

    const currentSteps = Array.from(new Set(
      (manifest.steps ?? [])
        .filter((step) => existsSync(join(outputDir, testName, `${step.name}.png`)))
        .map((step) => step.name),
    ));

    if (currentSteps.length === 0) {
      noScreenshots++;
      continue;
    }

    passed++;

    const acceptedTestDir = join(acceptedDir, testName);
    let hasChanges = false;

    if (!existsSync(acceptedTestDir)) {
      hasChanges = true;
    } else {
      const acceptedSteps = readdirSync(acceptedTestDir)
        .filter((fileName) => fileName.endsWith('.png') && fileName !== 'error.png')
        .map((fileName) => fileName.slice(0, -4))
        .sort();

      if (currentSteps.length !== acceptedSteps.length) {
        hasChanges = true;
      } else {
        for (const stepName of currentSteps) {
          const acceptedFile = join(acceptedTestDir, `${stepName}.png`);
          const currentFile = join(outputDir, testName, `${stepName}.png`);
          if (!existsSync(acceptedFile) || !(await areImagesEquivalent(acceptedFile, currentFile))) {
            hasChanges = true;
            break;
          }
        }
      }
    }

    if (hasChanges) {
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
  const summary = await getVisualSummary(
    process.env.SHOTEST_OUTPUT_DIR || 'test-results',
    process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted',
  );

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

  const status = runPlaywright(argv);

  if (firstArg === 'test') {
    const hasVisualChanges = await printVisualSummary();
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