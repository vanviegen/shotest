import { expect, test } from 'shotest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// A checkout of a small project that is tested with ShoTest.
function checkout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotest-checkout-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write('.gitignore', 'node_modules\ntest-results\n');
  write('package.json', '{ "type": "module" }\n');
  write('playwright.config.js', `import { defineConfig } from 'shotest';
export default defineConfig({ testDir: 'tests', use: { screenshot: 'off' } });
`);
  write('tests/hello.spec.js', `import { test, expect } from 'shotest';
test('hello', async ({ page }) => {
  await page.setContent('<h1>Hello</h1>');
  await expect(page.getByText('Hello')).toBeVisible();
});
`);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(root, path.join(dir, 'node_modules', 'shotest'));
  fs.symlinkSync(path.join(root, 'node_modules', '@playwright'), path.join(dir, 'node_modules', '@playwright'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

// `shotest test` there, in the browser this test itself runs in.
function runTests(dir, cache) {
  const { SHOTEST_RUN_ALL, ...env } = process.env;
  return execFileSync(process.execPath, [path.join(root, 'build', 'cli.js'), 'test', '--no-container'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...env, SHOTEST_CACHE_DIR: cache },
  });
}

// The test's record and its screenshots, by file name.
function results(dir) {
  const resultsDir = path.join(dir, 'test-results');
  return Object.fromEntries(fs.readdirSync(resultsDir)
    .filter((file) => /^[^.].*\.(json|png)$/.test(file))
    .map((file) => [file, fs.readFileSync(path.join(resultsDir, file)).toString('base64')]));
}

test('a test that passed on a source tree is not run again, in another checkout either', () => {
  test.setTimeout(60_000);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'shotest-cache-'));
  const first = checkout();
  expect(runTests(first, cache)).toContain('1 passed');
  expect(Object.keys(results(first))).toHaveLength(2);

  const second = checkout();
  expect(runTests(second, cache)).toContain('1 skipped');
  expect(results(second)).toEqual(results(first));
  // Testing leaves the files git tracks alone.
  expect(fs.existsSync(path.join(second, 'test-accepted'))).toBe(false);

  for (const dir of [cache, first, second]) fs.rmSync(dir, { recursive: true, force: true });
});
