#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const argv = process.argv.slice(2);
let failOnVisualChanges = false;
if (argv.indexOf('--fail-on-visual-changes') >= 0) {
  failOnVisualChanges = true;
  argv = argv.filter((arg) => arg !== '--fail-on-visual-changes');
}
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
  let noScreenshots = 0;

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

    const currentSteps = Array.from(new Set((manifest.steps ?? [])
      .filter((step) => existsSync(join(outputDir, testName, step.name + '.png')))
      .map((step) => step.name)));

    if (currentSteps.length === 0) {
      noScreenshots++;
      continue;
    }

    passed++;

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

  if (passed === 0 && noScreenshots === 0) return null;
  return { passed, changed, unchanged, noScreenshots };
}

function printVisualSummary() {
  const summary = getVisualSummary(
    process.env.SHOTEST_OUTPUT_DIR || 'test-results',
    process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted',
  );

  if (!summary) return false;

  const noScreenshotsText = summary.noScreenshots > 0
    ? `, ${summary.noScreenshots} passed with no screenshots`
    : '';

  console.log(`\nShoTest visuals: ${summary.changed} changed, ${summary.unchanged} unchanged across ${summary.passed} passed test(s)${noScreenshotsText}`);
  if (summary.changed > 0) console.log('Run "npx shotest review" to review and accept visual changes');
  return summary.changed > 0;
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

const result = spawnSync(process.execPath, [cliPath, ...argv], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (argv[0] === 'test') {
  const hasVisualChanges = printVisualSummary();
  if ((result.status ?? 0) === 0 && hasVisualChanges && failOnVisualChanges) {
    process.exit(1);
  }
}

process.exit(result.status ?? 0);
