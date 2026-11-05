import { expect } from 'shotest';
import fs from 'node:fs';
import path from 'node:path';
import { test, fixtureDir } from './review-app.js';

const CHANGED = 'example-spec-changed-removed-and-new-steps-527f02d4';
const COMMENTED = 'example-spec-unchanged-with-a-comment-7e8c5eff';
const FAILED = 'example-spec-new-and-failed-c43e054a';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));

test('navigate, align, accept, comment and apply', async ({ page, review }) => {
  await page.goto('/');
  await expect(page.getByText('with visual changes')).toBeVisible();
  await page.getByText('Start reviewing (2)').click();
  await page.waitForTimeout(300); // the panel scrolls to its first change 150ms after opening

  await expect(page.getByRole('heading', { name: 'changed, removed and new steps' })).toBeVisible();
  // The step gone from the run is aligned by its events, not by its index:
  // it shows as removed before the one whose look changed.
  await expect(page.getByRole('main').getByText(/^(unchanged|changed|new|removed)$/))
    .toHaveText(['unchanged', 'removed', 'changed', 'unchanged', 'new']);
  for (const side of ['accepted', 'diff', 'current']) {
    const button = page.getByRole('button', { name: side, exact: true });
    await button.click();
    await expect(button).toHaveClass(/pinned/);
  }
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.waitForTimeout(300); // the next test's Accept button opens under the mouse, its tooltip on the browser's own time

  // Accepting moves on to the next undecided test.
  await expect(page.getByRole('heading', { name: 'new, and failed' })).toBeVisible();
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
  expect(readJson(path.join(review.accepted, `${CHANGED}.json`)).steps.map((step) => step.image))
    .toEqual(['b5fad775a41a8926', 'cb13e709e7967d41', '215625bbeb7467c3', 'dc1fd2f16236ca84']);
  expect(accepted).toEqual(expect.arrayContaining(['cb13e709e7967d41.webp', 'dc1fd2f16236ca84.webp']));
  // The replaced baseline's images are unreferenced now, and gone.
  expect(accepted).not.toContain('623d48343fa21f96.webp');
  expect(accepted).not.toContain('e22d631190963309.webp');
  expect(accepted.filter((file) => file.endsWith('.passed'))).toHaveLength(1);
  expect(readJson(path.join(review.accepted, `${FAILED}.comments.json`)).comments.map((comment) => comment.text))
    .toEqual(['Should not throw']);
  expect(accepted).not.toContain(`${COMMENTED}.comments.json`);
  expect(fs.existsSync(path.join(review.dir, 'test-results', '.review-session.json'))).toBe(false);
});

test('discard', async ({ page, review }) => {
  await page.goto('/');
  await expect(page.getByText('Start reviewing (2)')).toBeVisible();
  await page.keyboard.press('Control+ArrowDown');
  await page.waitForTimeout(300); // the panel scrolls to its first change 150ms after opening
  await expect(page.getByRole('heading', { name: 'changed, removed and new steps' })).toBeVisible();
  await page.keyboard.press('a');
  await expect(page.getByRole('heading', { name: 'new, and failed' })).toBeVisible();
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
