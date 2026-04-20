import { test as baseTest, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { stripPngMetadata } from './png.js';

export { expect };
export type { Page };

// ── Configuration ──────────────────────────────────────────────────

const captureHtml = process.env.SHOTEST_CAPTURE_HTML !== 'false';

type VideoMode = 'on' | 'retain-on-failure' | 'on-first-retry';

export function getVideoModeOverride(): VideoMode | null {
    const override = process.env.SHOTEST_VIDEO?.trim().toLowerCase();
    if (!override || override === 'off' || override === 'false' || override === '0') {
        return null;
    }
    if (override === 'retain-on-failure' || override === 'on-first-retry') {
        return override;
    }
    return 'on';
}

export function detectVideoMode(testInfo: TestInfo): boolean {
    const override = process.env.SHOTEST_DEMO;
    if (override === 'on') return true;
    if (override === 'off') return false;

    if (getVideoModeOverride()) return true;

    const use = (testInfo as any).project?.use;
    const videoConfig = use?.video;
    if (videoConfig === 'on' || (typeof videoConfig === 'object' && videoConfig?.mode === 'on')) {
        return true;
    }

    if (use?.headless === false) return true;

    return false;
}

const VIDEO_INIT_CSS = `
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

// ── Stack trace helpers ────────────────────────────────────────────

type SourceLocation = { file: string; line: number };
type OverlayBannerType = 'info' | 'error' | 'success';
type OverlayNotice = { text: string; type: OverlayBannerType };

function getLocationFromStack(stack: string): SourceLocation | null {
    const frames = stack.split('\n');

    // Look for test/spec files first
    for (const frame of frames) {
        const match = frame.match(/([^\s(]+\.(spec|test)\.[jt]sx?):(\d+):\d+/);
        if (match) {
            let file = match[1];
            file = file.replace(/^file:\/\//, '');
            return { file, line: parseInt(match[3]) };
        }
    }

    // Fallback: first non-internal frame
    for (const frame of frames) {
        if (frame.includes('node_modules')) continue;
        const match = frame.match(/(?:at .+? \()?([^()\s]+):(\d+):\d+\)?$/);
        if (match && !match[1].includes('/shotest/')) {
            let file = match[1];
            file = file.replace(/^file:\/\//, '');
            return { file, line: parseInt(match[2]) };
        }
    }

    return null;
}

function getCallerLocation(): SourceLocation {
    return getLocationFromStack(new Error().stack || '') || { file: 'unknown', line: 0 };
}



// ── Overlay helpers ────────────────────────────────────────────────

const OVERLAY_STYLE = `
    html, body, * {
        scroll-behavior: auto !important;
    }
    *, *::before, *::after {
        transition: none !important;
        animation: none !important;
    }
    .shotest-overlay.check,
    .shotest-overlay.assert {
        position: absolute;
        border-radius: 8px;
        border-bottom-left-radius: 0;
        pointer-events: none;
        z-index: 1000000;
    }
    .shotest-overlay.check {
        border: 2px solid #28a745;
        background: rgba(40, 167, 69, 0.2);
    }
    .shotest-overlay.assert {
        border: 2px solid #4fc1ff;
        background: rgba(79, 193, 255, 0.2);
    }
    .shotest-overlay.check > p,
    .shotest-overlay.assert > p {
        position: absolute;
        top: 100%;
        left: -2px;
        color: black;
        padding: 2px 6px;
        border-radius: 3px;
        border-top-left-radius: 0;
        font-size: 12px; white-space: nowrap; font-family: sans-serif;
    }
    .shotest-overlay.check > p { background: #28a745; }
    .shotest-overlay.assert > p { background: #4fc1ff; }
    #shotest-overlay-notices {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        pointer-events: none;
        z-index: 1000002;
    }
    .shotest-overlay.banner {
        position: relative;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 10px 20px;
        font-family: sans-serif;
        font-size: 14px;
        border-top: 2px solid #333;
        white-space: pre-wrap;
    }
    .shotest-overlay.banner.error { border-top-color: red !important; background: rgba(80, 0, 0, 0.9) !important; }
    .shotest-overlay.banner.info { border-top-color: #007acc !important; }
    .shotest-overlay.banner.success { border-top-color: #28a745 !important; }
`;

export async function waitForVisualStability(page: Page, timeoutMs: number = 400) {
    await page.waitForLoadState('domcontentloaded').catch(() => { });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 250) }).catch(() => { });

    await page.evaluate(async (timeout: number) => {
        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        const raf = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

        try {
            if ('fonts' in document) {
                await Promise.race([(document as any).fonts.ready, sleep(timeout)]);
            }
        } catch { }

        try {
            const pendingImages = Array.from(document.images)
                .filter((img) => !img.complete)
                .map((img) => new Promise((resolve) => {
                    img.addEventListener('load', resolve, { once: true });
                    img.addEventListener('error', resolve, { once: true });
                }));
            await Promise.race([Promise.all(pendingImages), sleep(timeout)]);
        } catch { }

        await new Promise<void>((resolve) => {
            let done = false;
            let idleTimer: ReturnType<typeof setTimeout> | undefined;

            const finish = () => {
                if (done) return;
                done = true;
                observer.disconnect();
                if (idleTimer) clearTimeout(idleTimer);
                resolve();
            };

            const observer = new MutationObserver(() => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(finish, 60);
            });

            observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true,
            });

            idleTimer = setTimeout(finish, 60);
            setTimeout(finish, timeout);
        });

        await raf();
        await raf();
    }, Math.max(120, timeoutMs)).catch(() => { });
}

async function waitForRepaint(page: Page) {
    await waitForVisualStability(page);
}

async function hideOverlay(page: Page) {
    try {
        await page.evaluate(() => {
            document.querySelectorAll('.shotest-overlay').forEach((el) => el.remove());
            const notices = document.getElementById('shotest-overlay-notices');
            if (notices) notices.remove();
        });
    } catch { }
}

async function showOverlayCheck(page: Page, box: { x: number; y: number; width: number; height: number }, text?: string, kind: 'check' | 'assert' = 'check') {
    try {
        await page.evaluate(({ x, y, w, h, text, kind }) => {
            const el = document.createElement('div');
            el.className = 'shotest-overlay ' + kind;
            document.body.appendChild(el);
            Object.assign(el.style, {
                left: (x + window.scrollX - 4) + 'px',
                top: (y + window.scrollY - 4) + 'px',
                width: (w + 8) + 'px',
                height: (h + 8) + 'px',
            });
            if (text) {
                const p = document.createElement('p');
                p.innerText = text;
                el.appendChild(p);
            }
        }, { x: box.x, y: box.y, w: box.width, h: box.height, text, kind });
    } catch { }
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

async function showOverlayBanners(page: Page, notices: OverlayNotice[], position: 'append' | 'prepend' = 'append'): Promise<boolean> {
    if (notices.length === 0) return true;
    try {
        await page.evaluate(({ notices, position }) => {
            let container = document.getElementById('shotest-overlay-notices');
            if (!container) {
                container = document.createElement('div');
                container.id = 'shotest-overlay-notices';
                document.body.appendChild(container);
            }

            const fragment = document.createDocumentFragment();
            for (const notice of notices) {
                const el = document.createElement('div');
                el.className = 'shotest-overlay banner ' + notice.type;
                el.textContent = notice.text;
                fragment.appendChild(el);
            }

            if (position === 'prepend' && container.firstChild) {
                container.insertBefore(fragment, container.firstChild);
            } else {
                container.appendChild(fragment);
            }
        }, { notices, position });
        return true;
    } catch {
        return false;
    }
}

async function showOverlayBanner(page: Page, text: string, type: OverlayBannerType = 'info') {
    await showOverlayBanners(page, [{ text: stripAnsi(text), type }]);
}

function queueOverlayBanner(text: string, type: OverlayBannerType = 'info') {
    pendingOverlayNotices.push({ text: stripAnsi(text), type });
}

function describeExpectation(method: string): string {
    if (method.includes('to.be.visible')) return 'expect visible';
    if (method.includes('to.be.hidden')) return 'expect hidden';
    if (method.includes('to.be.enabled')) return 'expect enabled';
    if (method.includes('to.be.disabled')) return 'expect disabled';
    if (method.includes('to.be.checked')) return 'expect checked';
    if (method.includes('to.have.text') || method.includes('to.contain.text')) return 'expect text';
    if (method.includes('to.have.value')) return 'expect value';
    if (method.includes('to.have.class') || method.includes('to.contain.class')) return 'expect class';
    if (method.includes('to.have.count')) return 'expect count';
    return 'expect';
}

// ── Screenshot capture ─────────────────────────────────────────────

export interface StepInfo {
    /** Filename without extension (e.g. "0010a") */
    name: string;
    /** Source location like "my-test.spec.ts:10" */
    source: string;
    /** Time spent producing this step screenshot in milliseconds */
    duration: number;
}

export interface TestManifest {
    file: string;
    title: string;
    line: number;
    status: string;
    duration: number;
    error: string | null;
    errorSource?: string | null;
    errorStack?: string | null;
    steps: StepInfo[];
}

let currentOutDir = '';
let currentSteps: StepInfo[] = [];
let lastScreenshotKey = '';
let lastScreenshotSeq = 0;
let lastStepLocation: SourceLocation | null = null;
let pendingFailureText = '';
let pendingOverlayNotices: OverlayNotice[] = [];
let failureCaptured = false;

async function takeScreenshot(
    actualPage: Page,
    alreadyStable: boolean = false,
    loc: SourceLocation = getCallerLocation(),
    stepStartTimeMs: number = Date.now(),
): Promise<StepInfo> {
    const key = currentOutDir + ':' + loc.line;
    if (lastScreenshotKey !== key) {
        lastScreenshotKey = key;
        lastScreenshotSeq = 0;
    } else {
        lastScreenshotSeq++;
    }

    if (!alreadyStable) {
        await waitForRepaint(actualPage);
    }

    let flushedPendingNotices = false;
    if (pendingOverlayNotices.length > 0) {
        flushedPendingNotices = await showOverlayBanners(actualPage, pendingOverlayNotices, 'prepend');
    }

    const name = `${loc.line.toString().padStart(4, '0')}${String.fromCharCode(97 + lastScreenshotSeq)}`;
    const basePath = path.join(currentOutDir, name);
    const relFile = path.relative(process.cwd(), loc.file);

    const captured = await captureStep(basePath, actualPage);
    if (captured && flushedPendingNotices) {
        pendingOverlayNotices = [];
    }

    const step = {
        name,
        source: `${relFile}:${loc.line}`,
        duration: Math.max(0, Date.now() - stepStartTimeMs),
    };
    currentSteps.push(step);
    return step;
}

/**
 * Take a named screenshot (clean, no overlay). Useful for promotional material.
 */
export async function screenshot(page: Page, name: string): Promise<void> {
    const loc = getCallerLocation();
    const stepStartTimeMs = Date.now();
    await waitForRepaint(page);
    const basePath = path.join(currentOutDir, name);
    const relFile = path.relative(process.cwd(), loc.file);

    await hideOverlay(page);
    await captureStep(basePath, page);
    currentSteps.push({
        name,
        source: `${relFile}:${loc.line}`,
        duration: Math.max(0, Date.now() - stepStartTimeMs),
    });
}

export async function splitIntoRoles<const Names extends readonly string[]>(page: Page, ...names: Names): Promise<{ [K in Names[number]]: Page }> {
    if (names.length === 0) throw new Error('splitIntoRoles(page, ...) requires at least one role name');
    const browser = page.context().browser();
    if (!browser) throw new Error('ShoTest could not access a browser instance for splitIntoRoles(page, ...)');
    let currentUrl = 'about:blank';
    try { currentUrl = page.url(); } catch { }
    const result: Partial<Record<Names[number], Page>> = {};
    const splitPages = new Map<string, Page>();
    for (let i = 0; i < names.length; i++) {
        const role = String(names[i]).trim() as Names[number];
        if (!splitPages.has(role)) {
            if (splitPages.size === 0 && i === 0) splitPages.set(role, page);
            else {
                const clone = await browser.newPage();
                if (currentUrl && currentUrl !== 'about:blank') await clone.goto(currentUrl).catch(() => { });
                splitPages.set(role, wrapPage(clone));
            }
        }
        result[role] = splitPages.get(role)!;
    }
    return result as { [K in Names[number]]: Page };
}

async function captureStep(basePath: string, page: Page): Promise<boolean> {
    let pngBuffer: Buffer;
    try {
        pngBuffer = await page.screenshot({ fullPage: false });
    } catch {
        return false; // page closed (e.g. test timed out)
    }
    pngBuffer = stripPngMetadata(pngBuffer);
    fs.writeFileSync(basePath + '.png', pngBuffer);

    await hideOverlay(page);

    if (captureHtml) {
        try {
            const { body, head } = await page.evaluate(() => ({
                body: document.body.outerHTML.replace(/<path .*?<\/path>/g, ''),
                head: document.head.outerHTML,
            }));
            fs.writeFileSync(basePath + '.body.html', body, 'utf-8');
            fs.writeFileSync(basePath + '.head.html', head, 'utf-8');
        } catch { }
    }

    return true;
}

// ── Locator wrapping ───────────────────────────────────────────────

function wrapLocator(actualLocator: Locator, actualPage: Page): Locator {
    const wrapped = Object.create(actualLocator) as any;

    const actionMethods = ['click', 'fill', 'type', 'press', 'check', 'uncheck', 'selectOption', 'hover', 'dblclick', 'clear'];
    for (const method of actionMethods) {
        wrapped[method] = async function (...args: any[]) {
            const loc = getCallerLocation();
            const stepStartTimeMs = Date.now();
            lastStepLocation = loc;
            const short = typeof args[0] === 'string' ? method + ' ' + JSON.stringify(args[0]) : method;
            const failureText = `Locator ${actualLocator} failed ${short}`;
            pendingFailureText = failureText;
            try {
                await hideOverlay(actualPage);
                await waitForVisualStability(actualPage, 250);
                await actualLocator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                const box = await actualLocator.boundingBox().catch(() => null);
                if (!box) {
                    throw new Error(failureText);
                }
                await showOverlayCheck(actualPage, box, short);
                await takeScreenshot(actualPage, true, loc, stepStartTimeMs);
                const result = await (actualLocator as any)[method](...args);
                pendingFailureText = '';
                return result;
            } catch (error: any) {
                await showOverlayBanner(actualPage, failureText, 'error');
                await takeScreenshot(actualPage, true, loc, stepStartTimeMs).catch(() => {});
                failureCaptured = true;
                if (error.stack) {
                    error.stack = error.stack.split('\n')
                        .filter((l: string) => !/shotest\//.test(l))
                        .join('\n');
                }
                throw error;
            }
        };
    }

    wrapped._expect = async function (method: string, options: any) {
        const loc = getCallerLocation();
        const stepStartTimeMs = Date.now();
        lastStepLocation = loc;
        const label = describeExpectation(method);
        const failureText = `${label} failed`;
        pendingFailureText = failureText;
        try {
            const result = await (actualLocator as any)._expect(method, options);
            await hideOverlay(actualPage);
            await waitForVisualStability(actualPage, 200);
            await actualLocator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
            const box = await actualLocator.boundingBox().catch(() => null);
            if (box) {
                await showOverlayCheck(actualPage, box, label, 'assert');
            } else {
                await showOverlayBanner(actualPage, label, 'info');
            }
            await takeScreenshot(actualPage, true, loc, stepStartTimeMs);
            pendingFailureText = '';
            return result;
        } catch (error: any) {
            await hideOverlay(actualPage);
            await waitForVisualStability(actualPage, 120);
            await actualLocator.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
            const box = await actualLocator.boundingBox().catch(() => null);
            if (box) {
                await showOverlayCheck(actualPage, box, failureText, 'assert');
            } else {
                await showOverlayBanner(actualPage, failureText, 'error');
            }
            await takeScreenshot(actualPage, true, loc, stepStartTimeMs).catch(() => {});
            failureCaptured = true;
            throw error;
        }
    };

    wrapped.waitFor = async function (options?: any) {
        const loc = getCallerLocation();
        const stepStartTimeMs = Date.now();
        lastStepLocation = loc;
        await (actualLocator as any).waitFor(options);
        await hideOverlay(actualPage);
        await waitForVisualStability(actualPage, 200);
        await actualLocator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
        const box = await actualLocator.boundingBox().catch(() => null);
        if (box) {
            await showOverlayCheck(actualPage, box, 'waitFor');
        } else {
            await showOverlayBanner(actualPage, 'waitFor', 'info');
        }
        await takeScreenshot(actualPage, true, loc, stepStartTimeMs);
    };

    const locatorReturning = ['locator', 'filter', 'nth', 'first', 'last', 'getByText', 'getByRole', 'getByPlaceholder', 'getByLabel', 'getByTestId', 'getByAltText', 'getByTitle'];
    for (const method of locatorReturning) {
        wrapped[method] = function (...args: any[]) {
            const sub = (actualLocator as any)[method](...args);
            return wrapLocator(sub, actualPage);
        };
    }

    return wrapped;
}

// ── Page wrapping ──────────────────────────────────────────────────

function wrapPage(actualPage: Page): Page {
    const wrapped = Object.create(actualPage) as any;

    const locatorReturning = ['locator', 'getByText', 'getByRole', 'getByPlaceholder', 'getByLabel', 'getByTestId', 'getByAltText', 'getByTitle'];
    for (const method of locatorReturning) {
        wrapped[method] = function (...args: any[]) {
            const loc = (actualPage as any)[method](...args);
            return wrapLocator(loc, actualPage);
        };
    }

    wrapped.goto = async function (url: string, options: any) {
        const loc = getCallerLocation();
        lastStepLocation = loc;
        await actualPage.goto(url, options);
        queueOverlayBanner('goto ' + url, 'info');
    };

    return wrapped;
}

// ── Test fixture ───────────────────────────────────────────────────

export const test = baseTest.extend({
    page: async ({ page }, use, testInfo) => {
        const actualPage = page;
        const videoMode = detectVideoMode(testInfo);

        // Use Playwright's own per-test output directory
        const outDir = testInfo.outputDir;
        currentOutDir = outDir;
        currentSteps = [];
        lastScreenshotKey = '';
        lastScreenshotSeq = 0;
        lastStepLocation = null;
        pendingFailureText = '';
        pendingOverlayNotices = [];
        failureCaptured = false;

        fs.mkdirSync(outDir, { recursive: true });

        // Set video mode flag and inject appropriate CSS
        await actualPage.addInitScript(({ isVideoMode, videoCss, overlayCss }: { isVideoMode: boolean; videoCss: string; overlayCss: string }) => {
            (window as any).__VIDEO_MODE__ = isVideoMode;
            const style = document.createElement('style');
            if (isVideoMode) {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                style.textContent = videoCss;
            } else {
                style.textContent = overlayCss;
            }
            if (document.head) document.head.appendChild(style);
            else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
        }, { isVideoMode: videoMode, videoCss: VIDEO_INIT_CSS, overlayCss: OVERLAY_STYLE });

        actualPage.on('console', (...args: any[]) => console.log('Browser:', ...args));
        actualPage.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

        if (videoMode) {
            await use(actualPage);
        } else {
            const wrappedPage = wrapPage(actualPage);
            await use(wrappedPage);
        }

        // Determine error info
        const errorObj = testInfo.error as any;
        let errorMessage: string | null = null;
        let errorSource: string | null = null;
        let errorStack: string | null = null;

        if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
            const rawStack = errorObj ? String(errorObj.stack || errorObj.message || '') : '';
            const failureLoc = getLocationFromStack(rawStack) || lastStepLocation || { file: testInfo.file, line: testInfo.line };

            errorMessage = stripAnsi(pendingFailureText || (errorObj ? String(errorObj.message || errorObj.value || testInfo.status) : `Test ${testInfo.status}`));
            errorSource = `${path.relative(process.cwd(), failureLoc.file)}:${failureLoc.line}`;
            errorStack = errorObj ? stripAnsi(rawStack) || null : null;

            // Only capture if our action/expect wrappers didn't already
            if (!videoMode && !failureCaptured) {
                await hideOverlay(actualPage);
                await showOverlayBanner(actualPage, errorMessage, 'error');
                await takeScreenshot(actualPage, true, failureLoc).catch(() => {});
            }

            let currentUrl = '';
            try { currentUrl = actualPage.url(); } catch { currentUrl = 'unavailable'; }

            fs.writeFileSync(path.join(outDir, 'error.txt'), [
                `Test: ${testInfo.title}`,
                `Status: ${testInfo.status}`,
                `Duration: ${testInfo.duration}ms`,
                `URL: ${currentUrl}`,
                `Source: ${errorSource}`,
                `Message: ${errorMessage}`,
                errorStack ? `Exception: ${errorStack}` : '',
            ].filter(Boolean).join('\n') + '\n', 'utf-8');
        }

        // Write manifest
        const manifest: TestManifest = {
            file: path.relative(process.cwd(), testInfo.file),
            title: testInfo.title,
            line: testInfo.line,
            status: testInfo.status || 'unknown',
            duration: testInfo.duration,
            error: errorMessage,
            errorSource: errorSource,
            errorStack: errorStack,
            steps: currentSteps,
        };
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    },
});
