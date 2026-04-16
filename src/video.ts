/**
 * shoTest video helpers — visual interaction effects for demo recordings.
 *
 * Video mode is auto-detected from Playwright config (video: 'on' or headless: false)
 * and can be overridden with the SHOTEST_DEMO environment variable ('on' or 'off').
 */

import type { Page } from '@playwright/test';

type Locator = ReturnType<Page['locator']>;

/**
 * Tap an element with a visible touch ripple effect.
 *
 * In video mode, shows an expanding ripple animation at the tap point and
 * waits briefly after clicking for a natural feel. When not in video mode,
 * performs an instant click with no delay.
 *
 * @param page - The Playwright page instance.
 * @param locator - The element to tap.
 * @param delayMs - Post-tap delay in video mode (default: 800ms). Ignored outside video mode.
 */
export async function demoTap(page: Page, locator: Locator, delayMs: number = 800): Promise<void> {
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

/**
 * Type text character-by-character with natural timing.
 *
 * In video mode, clicks the element and types each character with a delay,
 * simulating realistic human typing. When not in video mode, fills the input
 * instantly using `locator.fill()`.
 *
 * @param page - The Playwright page instance.
 * @param locator - The input element to type into.
 * @param text - The text to type.
 * @param charDelayMs - Delay between characters in video mode (default: 80ms). Ignored outside video mode.
 */
export async function demoType(page: Page, locator: Locator, text: string, charDelayMs: number = 80): Promise<void> {
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

/**
 * Pause for a specified duration (video mode only).
 *
 * In video mode, waits for the given number of milliseconds, useful for
 * giving viewers time to see the current state. When not in video mode,
 * returns immediately with no delay.
 *
 * @param page - The Playwright page instance.
 * @param ms - Duration to pause in milliseconds (default: 2000ms). Ignored outside video mode.
 */
export async function demoPause(page: Page, ms: number = 2000): Promise<void> {
    const hasVideo = await page.evaluate(() => (window as any).__VIDEO_MODE__ === true);
    if (hasVideo) {
        await page.waitForTimeout(ms);
    }
}

/**
 * Perform a swipe gesture with a visible touch indicator.
 *
 * In video mode, shows a circular touch indicator that follows the swipe
 * path with eased motion and a fade-out effect at the end. When not in
 * video mode, performs a fast programmatic swipe with no visual indicator.
 *
 * @param page - The Playwright page instance.
 * @param locator - The element to swipe on.
 * @param direction - Swipe direction: 'up', 'down', 'left', or 'right'.
 * @param distancePx - Distance to swipe in pixels (default: 200).
 */
export async function demoSwipe(page: Page, locator: Locator, direction: 'up' | 'down' | 'left' | 'right', distancePx: number = 200): Promise<void> {
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
