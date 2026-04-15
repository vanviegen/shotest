# shoTest

shoTest is a small wrapper around Playwright that provides:

- Automatic screenshots at every step of your test, overlaid with markers showing actions taken or elements verified.
- A local web app for browsing test results, comparing changes against the stored baseline, and accepting intentional changes.
- HTML snapshots at every step, for debugging (by coding agents).
- Helpers for recording demo videos with visible interactions and natural delays.

## Setup

Install the dependencies:

```bash
npm install -D shotest @playwright/test
npx playwright install chromium
```

Create a place for your tests:

```bash
mkdir -p tests
```

Put your specs in `tests/` and name them `*.spec.ts`.

Add the run output directory to `.gitignore`:

```gitignore
test-results/
```

A minimal `playwright.config.ts` for shoTest looks like this:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  use: {
    screenshot: 'off',
    trace: 'on-first-retry',
  },
});
```

The important differences from a more typical Playwright setup are:

- `screenshot: 'off'` — shoTest captures its own images
- `outputDir: 'test-results'` — this matches the default shoTest run directory
- `workers: 1` and `fullyParallel: false` — not strictly required, but they make visual runs more repeatable while getting started

## Basic usage

Instead of importing from Playwright directly, import from shoTest:

```ts
import { test, expect, screenshot } from 'shotest';

test('open settings', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Preferences')).toBeVisible();

  await screenshot(page, 'settings-open');
});
```

Most common page and locator actions are wrapped so that a screenshot is taken automatically during the test.

## Output directories

By default shoTest uses:

- `test-results/` for the current run
- `test-accepted/` for accepted baseline images

Usually you clean `test-results/` on each run and keep `test-accepted/` in version control.

## Reviewing changes

After running the tests:

```bash
npx shotest
```

Then open:

```text
http://localhost:3847
```

Use the review page to inspect failures, compare screenshots, and accept the new baseline when the change is intentional.

## Video helpers

For demo-style recordings, import from `shotest/video` instead of `shotest`:

```ts
import { test, expect, tap, slowType, pause, swipe } from 'shotest/video';

test('demo', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await tap(page, page.getByRole('button', { name: 'Open settings' }));
  await slowType(page, page.getByLabel('Name'), 'Living room');
  await pause(page, 1200);
});
```

The same spec can still run as a normal test. To record an actual video, you only need two things in the Playwright run:

- enable Playwright video output
- set `VIDEO_MODE=true`

A minimal recording config looks like this:

```ts
import { defineConfig } from '@playwright/test';

process.env.VIDEO_MODE = 'true';

export default defineConfig({
  use: {
    video: { mode: 'on' },
  },
});
```

In normal test mode the helpers run quickly. In video mode they add small delays and visible interaction effects.

## Configuration

You can override the defaults in code:

```ts
import { configure } from 'shotest';

configure({
  outputDir: 'my-results',
  expectedDir: 'my-baselines',
  captureHtml: true,
  stripMetadata: true,
});
```

Or through environment variables:

- `SHOTEST_OUTPUT_DIR`
- `SHOTEST_EXPECTED_DIR`
- `SHOTEST_CAPTURE_HTML`
- `SHOTEST_STRIP_METADATA`
- `SHOTEST_PORT`

