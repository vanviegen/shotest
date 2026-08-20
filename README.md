# ShoTest

**ShoTest 2.0 is here** 🎉 — screenshots are now content-hashed, tests run in a pinned container for pixel-exact comparison, and the review app was redesigned around per-step event lists with a pixel-diff view.

ShoTest is a small wrapper around Playwright Test that acts as a drop-in replacement and provides:

- Automatic screenshots at every step of your test, with the actions taken and elements verified logged as events alongside each screenshot.
- A local web app for browsing test results, comparing changes against the stored baseline, and accepting intentional changes.
- Deterministic rendering: tests run in the official Playwright container image by default, so screenshot comparison can be exact.
- HTML snapshots at every step, for debugging (by coding agents).
- Helpers for recording demo videos with visible interactions and natural delays.

![ShoTest review screenshot](screenshot.png)

## Setup

Install `shotest` (*instead* of installing `@playwright/test` directly) and install a browser:

```bash
npm install -D shotest
npx shotest install chromium
```

Create a `tests/` directory, in which your tests will live as `.spec.ts` files.

Add the `test-results` directory to `.gitignore`.

Create a `playwright.config.ts`, that may look something like this:

```ts
import { defineConfig } from 'shotest';

export default defineConfig({
  use: {
    baseURL: 'https://automationexercise.com/', // set to your app URL
    screenshot: 'off', // ShoTest captures its own screenshots
    viewport: { width: 450, height: 800 },
  },
  timeout: 5000, // ms before a test fails
  workers: 1, // set this if your app has state
  webServer: [ // start your test-servers here (optional)
    // { 
    //   command: 'exec npm run dev -- --port 25833',
    //   port: 25833,
    // },
  ]
});
```

If you use Claude Code, GitHub Copilot or another AI agent that supports Skills, the npm package includes a `skill/` directory with these docs, for in-context guidance while writing tests. To set it up:

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/shotest/skill .claude/skills/shotest
```

## Basic usage

ShoTest re-exports the full Playwright Test API, which you can use like normal. For example:

```ts
// tests/example.spec.ts
import { test } from 'shotest';

test('view and buy a product', async ({ page }) => {
    await page.goto('/');

    await page
        .locator('.product-image-wrapper', { hasText: 'Fancy Green Top' })
        .getByRole('link', { name: 'View Product' })
        .click();

    await page.getByRole('heading', { name: 'Fancy Green Top' }).waitFor();
    await page.getByRole('button', { name: /add to cart/i }).click();
    await page.getByRole('link', { name: /view cart/i }).click();
});
```

Most common page and locator actions are wrapped so that a screenshot is taken automatically during the test. Run the tests using:

```sh
npx shotest test
```

This writes results to `test-results/`: one `<spec-base>.json` per spec file, plus the screenshots and HTML snapshots, named by a hash of their pixel content (so identical frames share a single file). What happened at each moment — clicks, assertions, navigations — is recorded as *events* in the JSON, each with a message, source line and the viewport box of the element involved. Steps that don't change the page share a single screenshot carrying the whole list of events.

The `shotest` command forwards arguments to Playwright, so `npx shotest test --ui` maps to `playwright test --ui`.

With the `--fail-on-visual-changes` flag, `shotest test` exits non-zero if the screenshots differ from the accepted baseline, even when all assertions pass — useful for enforcing visual consistency in CI.

## Deterministic screenshots

Screenshot comparison is exact: two steps match only when their pixel hashes do, with no tolerance threshold. What makes that workable is a pinned rendering environment — rendering is a function of the browser build plus the OS font stack — so by default `npx shotest test` re-runs itself inside the official Playwright image matching your installed version, using `podman` or `docker` (in that order), with your project mounted at its real path. Results land in `test-results/` as usual.

- Pass `--no-container` (or set `SHOTEST_NO_CONTAINER=1`) to run natively. That is the CI pattern: make the Playwright image the job's own image (GitHub Actions: `container: mcr.microsoft.com/playwright:v1.59.1-noble` on the job) and run `npx shotest test --no-container`. A machine with no container runner gets a warning and a native run.
- Set `SHOTEST_IMAGE` to override the image, e.g. to pin a digest for byte-for-byte reproducibility.

A Playwright upgrade means a browser upgrade, which typically means re-accepting baselines once. Two caveats: baselines are only comparable when everyone (developers and CI) generates them from the same image on the same CPU architecture, and the bind-mounted `node_modules` must be loadable inside the Linux container — true on Linux hosts, but macOS/Windows hosts install their own platform's native modules, so there prefer a devcontainer, or let CI produce `test-results/` and review that.

## Step descriptions and skipping screenshots

Attach a one-line hint to what happens next; the review tool shows it as a header above the events that follow it:

```ts
page.describe('Create lunch talk event');
await page.getByRole('button', { name: 'New event' }).click();
```

Routine flows that reoccur in many tests (logging in, seeding data) would otherwise produce countless screenshots. Wrap them in `withoutScreenshots(description, fn)` to skip capture — the review tool shows a placeholder with your description instead, and the wrapped part runs faster too:

```ts
import { test, withoutScreenshots } from 'shotest';

test('create event', async ({ page }) => {
  await withoutScreenshots('Log in as admin', async () => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('admin@example.com');
    await page.getByRole('button', { name: 'Log in' }).click();
  });
  // ...the part this test is actually about, with screenshots as usual
});
```

A failure inside the block still captures an error screenshot, and explicit `screenshot(page, name)` calls still capture.

## Reviewing and accepting visual changes

To review test results, compare changes against the baseline, and accept intentional changes:

```bash
npx shotest review
```

This serves a web app on localhost and opens it in your default browser.

Each screenshot is shown with its list of recorded events right beneath it, color-coded by type and prefixed with source line — browser console output included, interleaved between the events it arrived between. The viewport areas the events involved are outlined on the image; hover the image to see it unobstructed, or hover a single event to highlight just that one. When a step changed, the accepted and current versions are cross-faded, and buttons on the step's status tag pin either side or show the changed pixels as an amplified diff.

When you press 'Accept visuals' for a test, its screenshots are copied into `test-accepted/` (configurable through `SHOTEST_ACCEPTED_DIR`) and become the new accepted baseline. Commit this directory to version control (unlike `test-results/`). To keep it small, accepted images are recompressed to lossless WebP by a background job; hashes are computed from pixels, not file bytes, so names don't change.

Baselines for tests that produced no results at all are listed separately at the bottom, under *not in test-results/*. Usually their test was renamed or deleted and the baseline should go — but the same thing happens when a test simply didn't run (e.g. a filtered run), so ShoTest never removes one on its own. Selecting such an entry shows what would be deleted, and 'Delete baseline' removes it.

## Garbage collection

`npx shotest gc` deletes pool images (and HTML snapshots) in `test-results/` and `test-accepted/` that are no longer referenced by any of the JSON files there. You'll rarely need it: `test-results/` is cleaned automatically after a fully green `npx shotest test` run with no further arguments (extra arguments could mean a filtered run, which sees only part of the picture), and `test-accepted/` is cleaned whenever the review app accepts or deletes a baseline.

## Multi-user tests

ShoTest can label screenshots per browser page, which makes multi-user interaction tests practical to script and review. Call `splitIntoRoles(page, ...)` before the first interaction you want attributed to a role: it repurposes the current `page` for the first role and creates additional labeled browser sessions for the later roles, opened on the same URL.

```ts
import { test, expect, splitIntoRoles } from 'shotest';

test('buyer sees seller status update', async ({ page }) => {
  await page.goto('/orders');

  const { seller, buyer } = await splitIntoRoles(page, 'seller', 'buyer');

  await seller.getByRole('button', { name: 'Mark as shipped' }).click();
  await buyer.getByText('Shipped').waitFor();

  await expect(buyer.getByText('Shipped')).toBeVisible();
});
```

Repeating a role name within a test returns the same page instead of creating a duplicate session. In the review app, each role's screenshots throw a drop shadow in that role's colour, so the browser windows are easy to tell apart. Extra pages are closed automatically at the end of the test.

## Recording demo videos

ShoTest includes helper functions for recording demonstration videos with visible interactions and natural delays:

- `demoTap(page, locator, delayMs?)` — tap with a visible touch ripple.
- `demoType(page, locator, text, charDelayMs?)` — type character-by-character with natural timing.
- `demoPause(page, ms?)` — pause so viewers can take in the current state.
- `demoSwipe(page, locator, direction, distancePx?)` — swipe (`'up' | 'down' | 'left' | 'right'`) with a visible touch indicator.

```ts
import { test, expect, demoTap, demoType, demoPause } from 'shotest';

test('demo', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await demoTap(page, page.getByRole('button', { name: 'Open settings' }));
  await demoType(page, page.getByLabel('Name'), 'Living room');
  await demoPause(page, 1200);
});
```

These helpers only apply their delays and touch effects when *demo mode* is active; otherwise they run as fast as possible, so demo scripts can be part of your regular test suite without an outsized impact on runtime. Demo mode activates automatically when Playwright video recording is enabled or when running headed; override it by setting `SHOTEST_DEMO` to `on` or `off`.

A convenient way to record demo videos for a run:

```sh
SHOTEST_VIDEO=on npx shotest test
```

This uses Playwright's normal video output handling, so the videos are written to the standard per-test output directory under `test-results/`.

## Environment variables

For test recording:

- `SHOTEST_CAPTURE_HTML`: Set to `false` to skip capturing DOM HTML alongside screenshots (captured by default)
- `SHOTEST_VIDEO`: Enables Playwright video recording for the run. Set it to `on`, `retain-on-failure`, or `on-first-retry`; set it to `off` to disable it.
- `SHOTEST_DEMO`: Whether the demo helper functions emulate user behavior (`on` or `off`, defaults to auto-detecting video recording or headed mode)
- `SHOTEST_NO_CONTAINER`: Set to `1` to run tests natively instead of in the Playwright container
- `SHOTEST_IMAGE`: Container image to run tests in (defaults to the Playwright image matching your installed version)

For the review server:

- `SHOTEST_OUTPUT_DIR`: Where to read test results (defaults to `test-results`)
- `SHOTEST_ACCEPTED_DIR`: Where to store accepted baseline images (defaults to `test-accepted`)
- `SHOTEST_PORT`: Preferred web server TCP port (defaults to `3847`; if unavailable, ShoTest tries the next 9 ports)
