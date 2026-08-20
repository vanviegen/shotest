#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
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

function getVisualSummary(outputDir: string, acceptedDir: string): VisualSummary | null {
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

    const currentEntries = buildAlignEntries(record.steps);
    const acceptedEntries = buildAlignEntries(acceptedByKey.get(testId(record))?.steps ?? []);
    if (hasVisualChanges(acceptedEntries, currentEntries)) {
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

function printVisualSummary(): boolean {
  const summary = getVisualSummary(getOutputDir(), getAcceptedDir());

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

// ── Containerized test runs ────────────────────────────────────────
//
// Screenshot comparison is exact (pixel-hash equality), which is only fair
// when every run renders identically. Rendering is a function of the browser
// build plus the OS-level font stack, so `shotest test` runs the tests inside
// the Playwright Docker image matching the installed @playwright/test version
// by default. Skipped only with --no-container / SHOTEST_NO_CONTAINER=1 —
// pass that in CI, where the job itself should already run inside the image.

function playwrightVersion(): string {
  return require('@playwright/test/package.json').version as string;
}

function containerImage(): string {
  // Note: version tags are practically stable but not contractually
  // immutable. Teams wanting byte-for-byte pinning can set SHOTEST_IMAGE to
  // a digest reference (mcr.microsoft.com/playwright@sha256:...).
  return process.env.SHOTEST_IMAGE || `mcr.microsoft.com/playwright:v${playwrightVersion()}-noble`;
}

function findContainerRunner(): string | null {
  for (const runner of ['podman', 'docker']) {
    const probe = spawnSync(runner, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return runner;
  }
  return null;
}

/**
 * Re-run `shotest test` inside the pinned Playwright image, with the project
 * mounted at its host path so every path in output and results stays valid.
 * The inner invocation is this very CLI file run by the image's node — not
 * npx, which would fall back to the registry when the local install isn't
 * visible in the mount. The inner run gets --no-container and handles
 * everything (summary, gc, --fail-on-visual-changes); we relay its status.
 */
function runTestsInContainer(runner: string, argv: string[]): number {
  const image = containerImage();
  const cwd = process.cwd();
  console.log(`ShoTest: running tests in ${runner} using ${image} (use --no-container to run natively)`);

  const args = ['run', '--rm', '--init', '--ipc=host', '-v', `${cwd}:${cwd}`, '-w', cwd];

  // The shotest package usually lives inside cwd (node_modules/shotest), but
  // with hoisted monorepo installs or a file: link it can sit outside the
  // cwd mount — mount its surrounding node_modules (or bare package root) too
  // so the CLI and the dependencies next to it resolve inside the container.
  const cliPath = realpathSync(process.argv[1]);
  let packageRoot = path.dirname(path.dirname(cliPath)); // build/cli.js → package root
  if (path.basename(path.dirname(packageRoot)) === 'node_modules') packageRoot = path.dirname(packageRoot);
  if (!(packageRoot + path.sep).startsWith(cwd + path.sep)) args.push('-v', `${packageRoot}:${packageRoot}`);

  if (runner === 'podman') {
    // Rootless podman maps container root onto the invoking user, so files
    // written to the mount come out owned by the user; disabling SELinux
    // labeling for the container avoids relabeling the project directory.
    args.push('--security-opt', 'label=disable');
  } else {
    // Docker writes to the bind mount as the container user; run as the host
    // user so results aren't root-owned. The image has no home for that uid.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    args.push('-u', `${uid}:${gid}`, '-e', 'HOME=/tmp/shotest-home');
  }
  for (const [key, value] of Object.entries(process.env)) {
    // Forward ShoTest's own configuration, but not the host's browser path —
    // the whole point is to use the image's browsers at /ms-playwright.
    if (key.startsWith('SHOTEST_') && value !== undefined) args.push('-e', `${key}=${value}`);
  }
  args.push(image, 'node', cliPath, ...argv, '--no-container');

  const result = spawnSync(runner, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main(): Promise<void> {
  let argv = process.argv.slice(2);
  let failOnVisualChanges = false;
  let noContainer = !!process.env.SHOTEST_NO_CONTAINER;

  if (argv.includes('--fail-on-visual-changes')) {
    failOnVisualChanges = true;
    argv = argv.filter((arg) => arg !== '--fail-on-visual-changes');
  }
  if (argv.includes('--no-container')) {
    noContainer = true;
    argv = argv.filter((arg) => arg !== '--no-container');
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

  if (firstArg === 'test' && !noContainer) {
    const runner = findContainerRunner();
    if (runner) {
      // Forward the original arguments (including --fail-on-visual-changes)
      // untouched; the containerized invocation handles the whole run.
      process.exit(runTestsInContainer(runner, process.argv.slice(2)));
    }
    console.warn(
      'ShoTest: neither podman nor docker is available — running natively.\n' +
      `Rendering may not match baselines made in ${containerImage()}.\n` +
      'In CI, run the job inside that image and pass --no-container; locally, install podman or docker.');
  }

  const status = runPlaywright(argv);

  if (firstArg === 'test') {
    const hasVisualChanges = printVisualSummary();
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
