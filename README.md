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

## Recording demo videos

shoTest includes helper functions for recording demonstration videos with visible interactions and natural delays. They are exported directly from `shotest`, alongside the regular Playwright functions:
 
```ts
import { test, expect, demoTap, demoType, demoPause, demoSwipe } from 'shotest';

test('demo', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await demoTap(page, page.getByRole('button', { name: 'Open settings' }));
  await demoType(page, page.getByLabel('Name'), 'Living room');
  await demoPause(page, 1200);
});
```

**Important:** These helpers can run in two modes:

- Demo mode. The helper functions will emulate real user interactions with small delays, and add touch effects to taps and swipes. No overlaid screenshots are captured, so as not to disturb the video.
- Regular test mode, meaning they run as fast as possible with no delays or visual effects. This allows you to include your demo recording script in your test suite, without an outsized impact on test runtime.

Demo mode is automatically activated when Playwright video recording is enabled, when `SHOTEST_VIDEO` is set for the run, or when it's running in headed mode. You can override this by setting the `SHOTEST_DEMO` environment variable to `on` or `off`.

To record demo videos for a run, set `SHOTEST_VIDEO` when invoking Playwright:

```sh
SHOTEST_VIDEO=on npx playwright test
```

This uses Playwright's normal video output handling, so the videos are written to the standard per-test output directory under `test-results/`. You can also use Playwright's other video modes, for example:

```sh
SHOTEST_VIDEO=retain-on-failure npx playwright test
```


## Environment variables

For test recording:

- `SHOTEST_CAPTURE_HTML`: Whether to capture DOM HTML alongside screenshots (`'on'` or `'off'`, defaults to `'off'`)
- `SHOTEST_VIDEO`: Enables Playwright video recording for the run. Set it to `on`, `retain-on-failure`, or `on-first-retry`; set it to `off` to disable it.
- `SHOTEST_DEMO`: Whether the video helper methods emulate user behavior (`'on'` or `'off'`, defaults to auto-detecting recording, `SHOTEST_VIDEO`, or headed mode)

For the review server:

- `SHOTEST_OUTPUT_DIR`: Where to read test results (defaults to `test-results`)
- `SHOTEST_ACCEPTED_DIR`: Where to store accepted baseline images (defaults to `test-accepted`)
- `SHOTEST_PORT`: Web server TCP port (defaults to `3847`)
