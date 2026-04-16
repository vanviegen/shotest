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

import { defineConfig as playwrightDefineConfig } from '@playwright/test';
import { test, expect, screenshot, waitForVisualStability, getVideoModeOverride } from './fixture.js';
import type { TestManifest, StepInfo } from './fixture.js';

function applyShotestDefaults(config: Record<string, any>): Record<string, any> {
  const videoMode = getVideoModeOverride();
  if (!videoMode) return config;

  const use = { ...(config?.use ?? {}) };
  const currentVideo = use.video;

  use.video = typeof currentVideo === 'object' && currentVideo !== null
    ? { ...currentVideo, mode: videoMode }
    : { mode: videoMode };

  return { ...config, use };
}

export function defineConfig(
  ...configs: Parameters<typeof playwrightDefineConfig>
): ReturnType<typeof playwrightDefineConfig> {
  const updatedConfigs = configs.map((config) => applyShotestDefaults(config as Record<string, any>)) as Parameters<typeof playwrightDefineConfig>;
  return playwrightDefineConfig(...updatedConfigs);
}

export { test, expect, screenshot, waitForVisualStability };
export type { TestManifest, StepInfo };

export { demoTap, demoType, demoPause, demoSwipe } from './video.js';
