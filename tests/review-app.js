import { test as base } from 'shotest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The app under test is ShoTest's own review app. Every test gets a
// `shotest review` of its own, on a fresh copy of review-fixture/: results
// (test-results/) and baselines (test-accepted/) of the four tests in its
// tests/example.spec.js —
//   'changed, removed and new steps': one step's look changed, one step is
//     gone from the run (listed before the changed one), one is new;
//   'unchanged, with a comment': no changes, a reviewer's comment;
//   'new, and failed': no baseline yet, and the run failed;
//   'unchanged': nothing to review, but it ran on code that has changed
//     since.
export const fixtureDir = fileURLToPath(new URL('review-fixture', import.meta.url));
export const cli = fileURLToPath(new URL('../build/cli.js', import.meta.url));
const treeModule = fileURLToPath(new URL('../build/tree.js', import.meta.url));

// A copy of review-fixture/ to review in, as a project of its own: with
// this project's node_modules, so that Playwright can list its tests, and a
// git repository, whose source tree its results (but for 'unchanged') ran on.
export function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotest-review-'));
  fs.cpSync(fixtureDir, dir, { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(dir, 'node_modules'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const tree = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { sourceTreeHash } from ${JSON.stringify(treeModule)}; console.log(sourceTreeHash(['test-results', 'test-accepted']));`,
  ], { cwd: dir, encoding: 'utf-8' }).trim();
  const results = path.join(dir, 'test-results');
  for (const file of fs.readdirSync(results).filter((file) => file.endsWith('.json'))) {
    const record = JSON.parse(fs.readFileSync(path.join(results, file), 'utf-8'));
    if (record.title !== 'unchanged') fs.writeFileSync(path.join(results, file), JSON.stringify({ ...record, tree }));
  }
  return dir;
}

// The review app's page on one of the fixture's tests.
export const testUrl = (title) =>
  '/test/' + Buffer.from(JSON.stringify(['tests/example.spec.js', title])).toString('base64url');

async function freePort() {
  const server = net.createServer().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export const test = base.extend({
  // The port the review is served on. Playwright wants the baseURL of every
  // test, skipped ones included, so that must not take a review.
  port: async ({}, use) => use(await freePort()),
  baseURL: async ({ port }, use) => use(`http://localhost:${port}`),
  // `dir` holds the copy, `exited` resolves to the exit code once the review
  // is applied or discarded, and `output` is what the server printed.
  review: async ({ port }, use) => {
    const dir = fixtureProject();
    const server = spawn(process.execPath, [cli, 'review'], {
      cwd: dir,
      env: { ...process.env, SHOTEST_PORT: String(port) },
    });
    const review = { dir, accepted: path.join(dir, 'test-accepted'), output: '' };
    server.stdout.on('data', (chunk) => { review.output += chunk; });
    server.stderr.on('data', (chunk) => { review.output += chunk; });
    review.exited = new Promise((resolve) => server.on('exit', resolve));
    await new Promise((resolve, reject) => {
      server.stdout.on('data', () => {
        if (review.output.includes('- uri: ')) resolve();
      });
      server.on('exit', () => reject(new Error(`shotest review ended early:\n${review.output}`)));
    });
    await use(review);
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  },
  // Every page is of the review. The app flips changed steps between their
  // sides and pings the server on timers; stopped, every capture shows the
  // same moment.
  context: async ({ context, review }, use) => {
    await context.addInitScript(() => { window.setInterval = () => 0; });
    await use(context);
  },
});
