/**
 * shoTest — Screenshot testing for Playwright
 *
 * Usage:
 *   import { test, expect, screenshot } from 'shotest';
 *
 *   test('my test', async ({ page }) => {
 *     await page.goto('http://localhost:3000');
 *     await page.click('text=Login');  // auto-screenshot
 *     await screenshot(page, 'login-page');  // named screenshot
 *   });
 */

export * from '@playwright/test';

import { test, expect, screenshot, configure, waitForVisualStability } from './fixture.js';
import type { ShoTestConfig, TestManifest, StepInfo } from './fixture.js';

export { test, expect, screenshot, configure, waitForVisualStability };
export type { ShoTestConfig, TestManifest, StepInfo };
