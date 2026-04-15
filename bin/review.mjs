#!/usr/bin/env node
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reviewScript = join(__dirname, '..', 'src', 'review.ts');

execSync(`node --experimental-strip-types ${reviewScript} ${process.argv.slice(2).join(' ')}`, {
  stdio: 'inherit',
  cwd: process.cwd(),
});
