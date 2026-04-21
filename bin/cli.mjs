#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const argv = process.argv.slice(2);
const firstArg = argv[0];

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

process.exit(result.status ?? 0);
