# shoTest

shoTest is a small wrapper around Playwright Test that acts as a drop-in replacement and provides:

- Automatic screenshots at every step of your test, overlaid with markers showing actions taken or elements verified.
- A local web app for browsing test results, comparing changes against the stored baseline, and accepting intentional changes.
- HTML snapshots at every step, for debugging (by coding agents).
- Helpers for recording demo videos with visible interactions and natural delays.

![shoTest review screenshot](screenshot.png)

## Setup

Install the dependency and browser:

```bash
npm install -D shotest
npx playwright install chromium
```

The package also exposes the Playwright CLI, so standard commands like the browser installer keep working unchanged.

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
import { defineConfig } from 'shotest';

export default defineConfig({
  fullyParallel: false,
  workers: 1, // set this if your app has state
  use: {
    baseURL: 'https://google.com', // set to your app URL
    screenshot: 'off', // shoTest captures its own screenshots
  },
});
```

## Basic usage

shoTest re-exports the full Playwright Test API, so you can replace imports from Playwright directly with shoTest:

```ts
// tests/example.spec.ts
import { test, expect, screenshot } from 'shotest';

test('open settings', async ({ page }) => {
  await page.getBy('button', { name: 'Settings' }).click();
  await expect(page.getByText('Preferences')).toBeVisible();

  await screenshot(page, 'settings-open');
});
```

Everything from Playwright Test remains available, including symbols such as browsers, devices, and config helpers. Most common page and locator actions are wrapped so that a screenshot is taken automatically during the test.

Run the tests using:

```sh
npx playwright test
```

## Output directories

By default shoTest uses:

- Playwright's standard `test-results/` output folder for the current run
- `test-accepted/` for accepted baseline images

Each test run gets its own Playwright output subdirectory, and shoTest stores screenshots, HTML snapshots, and `manifest.json` there. Usually you clean `test-results/` on each run and keep `test-accepted/` in version control.

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

For demo-style recordings, import from `shotest/video` instead of `shotest`. It adds a couple of helper functions.

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
import { defineConfig } from 'shotest';

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
  acceptedDir: 'my-baselines',
  captureHtml: true,
  stripMetadata: true,
});
```

Or through environment variables:

- `SHOTEST_EXPECTED_DIR`
- `SHOTEST_CAPTURE_HTML`
- `SHOTEST_STRIP_METADATA`
- `SHOTEST_PORT`
- `SHOTEST_OUTPUT_DIR` (optional, for the review server if your Playwright `outputDir` is not `test-results`)

