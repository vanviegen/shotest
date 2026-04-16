/**
 * shoTest video mode — helpers for recording promotional demos.
 *
 * Usage:
 *   import { test, expect, tap, slowType, pause, swipe, screenshot } from 'shotest/video';
 *
 * In video mode (VIDEO_MODE=true env var), tap/slowType/pause/swipe add
 * visual indicators and delays. In test mode they run instantly.
 */

export * from '@playwright/test';

import { test as plainTest, expect } from '@playwright/test';
import { test as screenshottingTest, screenshot, configure, waitForVisualStability, type Page } from './fixture.js';
import * as path from 'path';
import * as fs from 'fs';

export { expect, screenshot, configure, waitForVisualStability };

type Locator = ReturnType<Page['locator']>;

const VIDEO_MODE = !!process.env.VIDEO_MODE;
const baseTest = VIDEO_MODE ? plainTest : screenshottingTest;

export const test = baseTest.extend({
    page: async ({ page }: { page: Page }, use: (page: Page) => Promise<void>) => {
        await page.addInitScript((videoMode: boolean) => {
            (window as any).__VIDEO_MODE__ = videoMode;

            if (videoMode) {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                const style = document.createElement('style');
                style.textContent = `
                    .shotest-touch-ripple {
                        position: fixed;
                        border: 4px solid rgba(255, 255, 255, 0.95);
                        border-radius: 50%;
                        pointer-events: none;
                        z-index: 10000000;
                        background: rgba(255, 255, 255, 0.15);
                        box-shadow: 0 0 20px rgba(255, 255, 255, 0.5);
                        animation: shotest-ripple-expand 600ms ease-out forwards;
                    }
                    @keyframes shotest-ripple-expand {
                        0% { width: 20px; height: 20px; opacity: 1; margin-left: -10px; margin-top: -10px; }
                        100% { width: 140px; height: 140px; opacity: 0; margin-left: -70px; margin-top: -70px; }
                    }
                    .shotest-swipe-indicator {
                        position: fixed;
                        width: 44px; height: 44px;
                        margin-left: -22px; margin-top: -22px;
                        border: 3px solid rgba(255, 255, 255, 0.85);
                        border-radius: 50%;
                        pointer-events: none;
                        z-index: 10000000;
                        background: rgba(255, 255, 255, 0.12);
                        box-shadow: 0 0 16px rgba(255, 255, 255, 0.4);
                        transition: opacity 350ms ease-out, transform 350ms ease-out;
                    }
                    .shotest-swipe-indicator.fade-out {
                        opacity: 0;
                        transform: scale(2.2);
                    }
                `;
                if (document.head) document.head.appendChild(style);
                else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            } else {
                const style = document.createElement('style');
                style.textContent = `
                    *, *::before, *::after { transition: none !important; animation: none !important; }
                `;
                if (document.head) document.head.appendChild(style);
                else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            }
        }, VIDEO_MODE);

        await use(page);

        // Video mode: copy video to build.video/
        if (VIDEO_MODE) {
            const videoPath = await page.video()?.path();
            if (videoPath) {
                await page.close();
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (fs.existsSync(videoPath)) {
                    const outputDir = path.join(process.cwd(), 'build.video');
                    fs.mkdirSync(outputDir, { recursive: true });
                    const destPath = path.join(outputDir, 'demo.webm');
                    fs.copyFileSync(videoPath, destPath);
                    console.log(`\n✅ Video saved to: ${destPath}\n`);
                    const playwrightDir = path.dirname(videoPath);
                    try { fs.rmSync(playwrightDir, { recursive: true, force: true }); } catch {}
                }
            }
        }
    },
});

/** Tap with visual ripple (video) or instant click (test) */
export async function tap(page: Page, locator: Locator, delayMs: number = 800): Promise<void> {
    const hasVideo = await page.evaluate(() => (window as any).__VIDEO_MODE__ === true);

    if (hasVideo) {
        const box = await locator.boundingBox();
        if (!box) throw new Error('Element not visible or has no bounding box');
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.evaluate(({ x, y }: { x: number; y: number }) => {
            const ripple = document.createElement('div');
            ripple.className = 'shotest-touch-ripple';
            ripple.style.left = `${x}px`;
            ripple.style.top = `${y}px`;
            document.body.appendChild(ripple);
            setTimeout(() => ripple.remove(), 650);
        }, { x: cx, y: cy });
        await page.waitForTimeout(200);
        await locator.click();
        await page.waitForTimeout(delayMs - 100);
    } else {
        await locator.click();
    }
}

/** Type character-by-character (video) or fill instantly (test) */
export async function slowType(page: Page, locator: Locator, text: string, charDelayMs: number = 80): Promise<void> {
    const hasVideo = await page.evaluate(() => (window as any).__VIDEO_MODE__ === true);
    if (hasVideo) {
        await locator.click();
        await page.waitForTimeout(200);
        for (const char of text) {
            await page.keyboard.type(char);
            await page.waitForTimeout(charDelayMs);
        }
    } else {
        await locator.fill(text);
    }
}

/** Pause for viewing time (video only, skipped in test mode) */
export async function pause(page: Page, ms: number = 2000): Promise<void> {
    const hasVideo = await page.evaluate(() => (window as any).__VIDEO_MODE__ === true);
    if (hasVideo) {
        await page.waitForTimeout(ms);
    }
}

/** Swipe gesture with visual indicator (video) or fast gesture (test) */
export async function swipe(page: Page, locator: Locator, direction: 'up' | 'down' | 'left' | 'right', distancePx: number = 200): Promise<void> {
    const hasVideo = await page.evaluate(() => (window as any).__VIDEO_MODE__ === true);

    const box = await locator.boundingBox();
    if (!box) throw new Error('Element not visible or has no bounding box');

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    let endX = startX, endY = startY;

    switch (direction) {
        case 'up': endY -= distancePx; break;
        case 'down': endY += distancePx; break;
        case 'left': endX -= distancePx; break;
        case 'right': endX += distancePx; break;
    }

    if (hasVideo) {
        await page.evaluate(({ x, y }: { x: number; y: number }) => {
            const dot = document.createElement('div');
            dot.className = 'shotest-swipe-indicator';
            dot.id = '__shotest_swipe__';
            dot.style.left = `${x}px`;
            dot.style.top = `${y}px`;
            document.body.appendChild(dot);
        }, { x: startX, y: startY });

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.waitForTimeout(120);

        const steps = 40;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const ease = 1 - Math.pow(1 - t, 3);
            const cx = startX + (endX - startX) * ease;
            const cy = startY + (endY - startY) * ease;
            await page.mouse.move(cx, cy);
            await page.evaluate(({ x, y }: { x: number; y: number }) => {
                const dot = document.getElementById('__shotest_swipe__');
                if (dot) { dot.style.left = `${x}px`; dot.style.top = `${y}px`; }
            }, { x: cx, y: cy });
            await page.waitForTimeout(18);
        }

        await page.waitForTimeout(60);
        await page.mouse.up();
        await page.evaluate(() => {
            const dot = document.getElementById('__shotest_swipe__');
            if (dot) { dot.classList.add('fade-out'); setTimeout(() => dot.remove(), 400); }
        });
        await page.waitForTimeout(450);
    } else {
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.waitForTimeout(50);
        const steps = 20;
        for (let i = 1; i <= steps; i++) {
            await page.mouse.move(
                startX + ((endX - startX) / steps) * i,
                startY + ((endY - startY) / steps) * i
            );
            await page.waitForTimeout(10);
        }
        await page.waitForTimeout(50);
        await page.mouse.up();
        await page.waitForTimeout(200);
    }
}
