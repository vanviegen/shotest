#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const builtReview = join(__dirname, '..', 'build', 'review.js');
const sourceReview = join(__dirname, '..', 'src', 'review.ts');

const args = existsSync(builtReview)
  ? [builtReview, ...process.argv.slice(2)]
  : ['--experimental-strip-types', sourceReview, ...process.argv.slice(2)];

execFileSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: process.cwd(),
});
