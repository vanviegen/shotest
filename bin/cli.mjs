#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const argv = process.argv.slice(2);
const firstArg = argv[0];

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
}

function getVisualSummary(outputDir, acceptedDir) {
  if (!existsSync(outputDir)) return null;

  const testDirs = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let passed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const testName of testDirs) {
    const manifestPath = join(outputDir, testName, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }

    if (manifest?.status !== 'passed') continue;
    passed++;

    const currentSteps = Array.from(new Set((manifest.steps ?? [])
      .filter((step) => existsSync(join(outputDir, testName, step.name + '.png')))
      .map((step) => step.name)));
    const acceptedTestDir = join(acceptedDir, testName);

    let hasChanges = false;
    if (!existsSync(acceptedTestDir)) {
      hasChanges = currentSteps.length > 0;
    } else {
      const acceptedSteps = readdirSync(acceptedTestDir)
        .filter((fileName) => fileName.endsWith('.png') && fileName !== 'error.png')
        .map((fileName) => fileName.slice(0, -4))
        .sort();

      if (currentSteps.length !== acceptedSteps.length) {
        hasChanges = true;
      } else {
        for (const stepName of currentSteps) {
          const acceptedFile = join(acceptedTestDir, stepName + '.png');
          if (!existsSync(acceptedFile) || hashFile(join(outputDir, testName, stepName + '.png')) !== hashFile(acceptedFile)) {
            hasChanges = true;
            break;
          }
        }
      }
    }

    if (hasChanges) changed++;
    else unchanged++;
  }

  if (passed === 0) return null;
  return { passed, changed, unchanged };
}

function printVisualSummary() {
  const summary = getVisualSummary(
    process.env.SHOTEST_OUTPUT_DIR || 'test-results',
    process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted',
  );

  if (!summary) return;

  console.log(`\nShoTest visuals: ${summary.changed} changed, ${summary.unchanged} unchanged across ${summary.passed} passed test(s)`);
}

if (firstArg === 'review') {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const builtReview = join(__dirname, '..', 'build', 'review.js');
  const sourceReview = join(__dirname, '..', 'src', 'review.ts');

  const reviewArgs = existsSync(builtReview)
    ? [builtReview, ...argv.slice(1)]
    : ['--experimental-strip-types', sourceReview, ...argv.slice(1)];

  const reviewResult = spawnSync(process.execPath, reviewArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  if (reviewResult.error) {
    console.error(reviewResult.error.message);
    process.exit(1);
  }

  process.exit(reviewResult.status ?? 0);
}

const require = createRequire(import.meta.url);
const cliPath = require.resolve('@playwright/test/cli');
const playwrightArgs = argv.length === 0 ? ['test'] : argv;

const result = spawnSync(process.execPath, [cliPath, ...playwrightArgs], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (playwrightArgs[0] === 'test') {
  printVisualSummary();
}

process.exit(result.status ?? 0);
