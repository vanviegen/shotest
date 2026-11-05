import { test as base } from 'shotest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The app under test is ShoTest's own review app. Every test gets a
// `shotest review` of its own, on a fresh copy of review-fixture/: a run
// (test-results/) and its baselines (test-accepted/) of four tests in a
// made-up tests/example.spec.js —
//   'changed, removed and new steps': one step's look changed, one step is
//     gone from the run (listed before the changed one), one is new;
//   'unchanged, with a comment': no changes, a reviewer's comment;
//   'new, and failed': no baseline yet, and the run failed;
//   'unchanged': nothing to review.
export const fixtureDir = fileURLToPath(new URL('review-fixture', import.meta.url));
const cli = fileURLToPath(new URL('../build/cli.js', import.meta.url));

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
  // `dir` holds the copy, `exited` resolves to the exit code once the review
  // is applied or discarded, and `output` is what the server printed.
  review: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotest-review-'));
    fs.cpSync(fixtureDir, dir, { recursive: true });
    const server = spawn(process.execPath, [cli, 'review'], {
      env: {
        ...process.env,
        SHOTEST_OUTPUT_DIR: path.join(dir, 'test-results'),
        SHOTEST_ACCEPTED_DIR: path.join(dir, 'test-accepted'),
        SHOTEST_PORT: String(await freePort()),
      },
    });
    const review = { dir, accepted: path.join(dir, 'test-accepted'), output: '' };
    server.stdout.on('data', (chunk) => { review.output += chunk; });
    server.stderr.on('data', (chunk) => { review.output += chunk; });
    review.exited = new Promise((resolve) => server.on('exit', resolve));
    review.url = await new Promise((resolve, reject) => {
      server.stdout.on('data', () => {
        const match = review.output.match(/- uri: (\S+)/);
        if (match) resolve(match[1]);
      });
      server.on('exit', () => reject(new Error(`shotest review ended early:\n${review.output}`)));
    });
    await use(review);
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  },
  baseURL: async ({ review }, use) => use(review.url),
  // The app flips changed steps between their sides and pings the server on
  // timers; stopped, every capture shows the same moment.
  context: async ({ context }, use) => {
    await context.addInitScript(() => { window.setInterval = () => 0; });
    await use(context);
  },
});
