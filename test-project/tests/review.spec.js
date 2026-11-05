import { test as base, expect } from 'shotest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The review app, run on a copy of review-fixture/: a demo-app run and its
// baselines, edited by hand into a changed test (with a changed, a removed
// and a new step), a new failed test, an unchanged test with a comment and a
// plainly unchanged one.
const fixtureDir = fileURLToPath(new URL('../review-fixture', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/shotest/build/cli.js', import.meta.url));

const CORE = 'shotest-spec-covers-core-wrapped-actions-and-assertions-668203e1';
const FAILED = 'shotest-spec-an-uncaught-page-exception-fails-the-test-a028cf50';
const HOVER = 'shotest-spec-keeps-a-hover-only-while-the-clicked-element-s-a6865de0';

async function freePort() {
  const server = net.createServer().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const test = base.extend({
  // A `shotest review` of its own: `exited` resolves to its exit code, once
  // the review is applied or discarded.
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
});

test.use({ viewport: { width: 1000, height: 700 } });

// The app flips changed steps between their sides and pings the server on
// timers; stopped, every capture shows the same moment.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.setInterval = () => 0; });
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

test('review: navigate, align, accept, comment and apply', async ({ page, review }) => {
  await page.goto(review.url);
  await expect(page.getByText('with visual changes')).toBeVisible();
  await page.getByText('Start reviewing (2)').click();
  await page.waitForTimeout(300); // the panel scrolls to its first change 150ms after opening

  await expect(page.getByRole('heading', { name: 'covers core wrapped actions and assertions' })).toBeVisible();
  // The step gone from the run is aligned by its events, not by its index:
  // it shows as removed before the one whose look changed.
  await expect(page.getByText(/^(unchanged|changed|new|removed)$/))
    .toHaveText(['unchanged', 'removed', 'changed', 'unchanged', 'new']);
  for (const side of ['accepted', 'diff', 'current']) {
    const button = page.getByRole('button', { name: side, exact: true });
    await button.click();
    await expect(button).toHaveClass(/pinned/);
  }
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.waitForTimeout(300); // the next test's Accept button opens under the mouse, its tooltip on the browser's own time

  // Accepting moves on to the next undecided test: the new, failed one.
  await expect(page.getByRole('heading', { name: 'an uncaught page exception fails the test' })).toBeVisible();
  await expect(page.getByText('uncaught in the page').last()).toBeVisible();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByRole('textbox').fill('Should not throw');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Should not throw')).toBeVisible();

  await page.getByLabel('Previous test').click();
  await expect(page.getByText('The outline should be blue')).toBeVisible();
  await page.getByRole('button', { name: 'Remove comment' }).click();
  await expect(page.getByText('The outline should be blue')).toHaveCount(0);

  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Review applied')).toBeVisible();
  // The failed test is neither accepted nor free of comments.
  expect(await review.exited).toBe(1);
  expect(review.output).toContain('Should not throw');

  const accepted = fs.readdirSync(review.accepted);
  expect(readJson(path.join(review.accepted, `${CORE}.json`)).steps.map((step) => step.image))
    .toEqual(['7b22e50dfb84447f', '918fc60cb1e489c9', '736506c4470cd546', '2bfefc9d071fc0b6']);
  expect(accepted).toEqual(expect.arrayContaining(['918fc60cb1e489c9.webp', '2bfefc9d071fc0b6.webp']));
  // The replaced baseline's images are unreferenced now, and gone.
  expect(accepted).not.toContain('583bac406341ef51.webp');
  expect(accepted).not.toContain('5803f4f88a5e5605.webp');
  expect(accepted.filter((file) => file.endsWith('.passed'))).toHaveLength(1);
  expect(readJson(path.join(review.accepted, `${FAILED}.comments.json`)).comments.map((comment) => comment.text))
    .toEqual(['Should not throw']);
  expect(accepted).not.toContain(`${HOVER}.comments.json`);
  expect(fs.existsSync(path.join(review.dir, 'test-results', '.review-session.json'))).toBe(false);
});

test('review: discard', async ({ page, review }) => {
  await page.goto(review.url);
  await expect(page.getByText('Start reviewing (2)')).toBeVisible();
  await page.keyboard.press('Control+ArrowDown');
  await page.waitForTimeout(300); // the panel scrolls to its first change 150ms after opening
  await expect(page.getByRole('heading', { name: 'covers core wrapped actions and assertions' })).toBeVisible();
  await page.keyboard.press('a');
  await expect(page.getByRole('heading', { name: 'an uncaught page exception fails the test' })).toBeVisible();
  await expect(page.getByText('1 undecided')).toBeVisible();

  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByText('Review discarded')).toBeVisible();
  expect(await review.exited).toBe(1);

  for (const file of fs.readdirSync(path.join(fixtureDir, 'test-accepted'))) {
    expect(fs.readFileSync(path.join(review.accepted, file))).toEqual(fs.readFileSync(path.join(fixtureDir, 'test-accepted', file)));
  }
  expect(fs.readdirSync(review.accepted)).toHaveLength(fs.readdirSync(path.join(fixtureDir, 'test-accepted')).length);
  expect(fs.existsSync(path.join(review.dir, 'test-results', '.review-session.json'))).toBe(false);
});
