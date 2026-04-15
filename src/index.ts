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

import { test, expect, screenshot, configure } from './fixture.js';
import type { ShoTestConfig, TestManifest, StepInfo } from './fixture.js';

export { test, expect, screenshot, configure };
export type { ShoTestConfig, TestManifest, StepInfo };
