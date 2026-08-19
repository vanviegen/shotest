import { test as baseTest, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { stripPngMetadata } from './png.js';
import { hashImagePixels } from './hash.js';
import { mergeTestRecord, type ConsoleMessageInfo, type StepRecord, type TestRecord } from './manifest.js';

export { expect };
export type { Page };
export type { ConsoleMessageInfo, StepRecord, TestRecord };

/** The page handed to tests: Playwright's Page plus ShoTest's describe(). */
export interface ShotestPage extends Page {
    /** Attach a one-line hint to the next screenshot, shown in the review tool. */
    describe(text: string): void;
}

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

/**
 * Wait for the page to be visually stable enough to screenshot.
 *
 * Playwright already handles the heavy lifting — actionability waits gate every
 * click/fill, web-first assertions auto-retry, and CSS animations/transitions
 * are disabled globally by the injected overlay stylesheet. The only things
 * left that can still cause a "wobbly" screenshot are:
 *   1. Web fonts not yet loaded (text reflows mid-shot).
 *   2. The browser not having flushed the latest layout to a frame.
 *
 * So: wait (briefly) for `document.fonts.ready`, then two rAFs to ensure the
 * compositor has painted. Everything else (networkidle, MutationObserver idle
 * loops, image-load polling) was redundant and slow.
 */
export async function waitForVisualStability(page: Page, timeoutMs: number = 500) {
    await page.evaluate((timeout: number) => new Promise<void>((resolve) => {
        const paint = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        const fonts = (document as Document & { fonts?: { ready: Promise<unknown>; status?: string } }).fonts;
        if (fonts && fonts.status !== 'loaded') {
            const cap = setTimeout(paint, timeout);
            fonts.ready.then(() => { clearTimeout(cap); paint(); }, () => paint());
        } else {
            paint();
        }
    }), timeoutMs).catch(() => { });
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

function describeLocatorInspection(method: string, args: any[]): string {
    if (method === 'getAttribute' && typeof args[0] === 'string') {
        return `getAttribute ${JSON.stringify(args[0])}`;
    }
    return method;
}

async function showLocatorStepOverlay(
    actualLocator: Locator,
    actualPage: Page,
    text: string,
    kind: 'check' | 'assert' = 'check',
    fallbackType: OverlayBannerType = 'info',
): Promise<void> {
    await hideOverlay(actualPage);
    await actualLocator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    // The underlying operation has already completed here, so the element is
    // either present now or never will be (e.g. after a successful negative
    // assertion like not.toBeVisible). A bounded wait keeps the absent case
    // from stalling for the full default timeout; we then fall back to a banner.
    const box = await actualLocator.boundingBox({ timeout: 1000 }).catch(() => null);
    if (box) {
        await showOverlayCheck(actualPage, box, text, kind);
    } else {
        await showOverlayBanner(actualPage, text, fallbackType);
    }
}

// ── Screenshot capture ─────────────────────────────────────────────

let currentPoolDir = '';
let currentSteps: StepRecord[] = [];
let lastStepLocation: SourceLocation | null = null;
let pendingFailureText = '';
let pendingOverlayNotices: OverlayNotice[] = [];
let pendingConsoleMessages: ConsoleMessageInfo[] = [];
let pendingDescription: string | undefined;
let suppressDepth = 0;
let failureCaptured = false;

function screenshotsSuppressed(): boolean {
    return suppressDepth > 0;
}

function setPageRole(page: Page, role: string): void {
    const actualPage = (page as any)._shotestActualPage ?? page;
    (actualPage as any)._shotestRole = role;
}

function getPageRole(page: Page): string | undefined {
    return (page as any)._shotestRole;
}

function setPendingDescription(text: string): void {
    pendingDescription = String(text);
}

function normalizeConsoleSource(source: { url?: string; lineNumber?: number; columnNumber?: number } | undefined): string | undefined {
    const url = source?.url?.trim();
    if (!url) return undefined;
    const lineNumber = typeof source?.lineNumber === 'number' ? source.lineNumber + 1 : undefined;
    const columnNumber = typeof source?.columnNumber === 'number' ? source.columnNumber + 1 : undefined;
    const normalizedUrl = url.startsWith(process.cwd()) ? path.relative(process.cwd(), url) : url;
    if (lineNumber && columnNumber) return `${normalizedUrl}:${lineNumber}:${columnNumber}`;
    if (lineNumber) return `${normalizedUrl}:${lineNumber}`;
    return normalizedUrl;
}

function drainPendingConsoleMessages(): ConsoleMessageInfo[] | undefined {
    if (pendingConsoleMessages.length === 0) return undefined;
    const messages = pendingConsoleMessages;
    pendingConsoleMessages = [];
    return messages;
}

function recordConsoleMessage(message: ConsoleMessageInfo): void {
    pendingConsoleMessages.push(message);
}

/**
 * Run `fn` without producing screenshots for the wrapped actions and
 * assertions, recording a single placeholder ("gap") step with the given
 * one-line description instead. Use it for routine flows that reoccur across
 * many tests (logging in, seeding data) to keep reviews focused — it also
 * skips the overlay and stability work, so the wrapped part runs faster.
 *
 * A failure inside the block still captures an error screenshot, and explicit
 * `screenshot(page, name)` calls still capture.
 */
export async function withoutScreenshots<T>(description: string, fn: () => Promise<T> | T): Promise<T> {
    if (suppressDepth === 0) {
        currentSteps.push({ gap: String(description) });
    }
    suppressDepth++;
    try {
        return await fn();
    } finally {
        suppressDepth--;
    }
}

async function takeScreenshot(
    actualPage: Page,
    alreadyStable: boolean = false,
    loc: SourceLocation = getCallerLocation(),
    stepStartTimeMs: number = Date.now(),
    force: boolean = false,
): Promise<void> {
    if (screenshotsSuppressed() && !force) return;

    if (!alreadyStable) {
        await waitForVisualStability(actualPage);
    }

    let flushedPendingNotices = false;
    if (pendingOverlayNotices.length > 0) {
        flushedPendingNotices = await showOverlayBanners(actualPage, pendingOverlayNotices, 'prepend');
    }

    const relFile = path.relative(process.cwd(), loc.file);

    const hash = await captureStep(actualPage);
    if (hash && flushedPendingNotices) {
        pendingOverlayNotices = [];
    }
    if (!hash) return; // page closed (e.g. test timed out)

    currentSteps.push({
        image: hash,
        source: `${relFile}:${loc.line}`,
        description: consumePendingDescription(),
        duration: Math.max(0, Date.now() - stepStartTimeMs),
        role: getPageRole(actualPage),
        consoleMessages: drainPendingConsoleMessages(),
    });
}

function consumePendingDescription(): string | undefined {
    const description = pendingDescription;
    pendingDescription = undefined;
    return description;
}

/**
 * Take a named screenshot (clean, no overlay). Useful for promotional material.
 * Captures even inside a withoutScreenshots() block.
 */
export async function screenshot(page: Page, name: string): Promise<void> {
    const loc = getCallerLocation();
    const stepStartTimeMs = Date.now();
    await waitForVisualStability(page);
    const relFile = path.relative(process.cwd(), loc.file);

    await hideOverlay(page);
    const hash = await captureStep(page);
    if (!hash) return;
    currentSteps.push({
        image: hash,
        name,
        source: `${relFile}:${loc.line}`,
        description: consumePendingDescription(),
        duration: Math.max(0, Date.now() - stepStartTimeMs),
        role: getPageRole(page),
        consoleMessages: drainPendingConsoleMessages(),
    });
}

export async function splitIntoRoles<const Names extends readonly string[]>(page: Page, ...names: Names): Promise<{ [K in Names[number]]: ShotestPage }> {
    if (names.length === 0) throw new Error('splitIntoRoles(page, ...) requires at least one role name');
    const browser = page.context().browser();
    if (!browser) throw new Error('ShoTest could not access a browser instance for splitIntoRoles(page, ...)');
    let currentUrl = 'about:blank';
    try { currentUrl = page.url(); } catch { }
    const result: Partial<Record<Names[number], ShotestPage>> = {};
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
        const rolePage = splitPages.get(role)!;
        setPageRole(rolePage, role);
        result[role] = rolePage as ShotestPage;
    }
    return result as { [K in Names[number]]: ShotestPage };
}

/**
 * Screenshot the page, write it to the pool under its pixel-content hash, and
 * return the hash. Identical frames — within this test or across tests — end
 * up as one file. HTML snapshots are keyed by the same hash.
 */
async function captureStep(page: Page): Promise<string | null> {
    let pngBuffer: Buffer;
    try {
        pngBuffer = await page.screenshot({ fullPage: false });
    } catch {
        return null; // page closed (e.g. test timed out)
    }
    pngBuffer = stripPngMetadata(pngBuffer);
    const hash = await hashImagePixels(pngBuffer);

    const basePath = path.join(currentPoolDir, hash);
    if (!fs.existsSync(basePath + '.png')) {
        // Write-then-rename: a concurrent worker producing the same hash is
        // writing the same bytes, and rename keeps readers from seeing either
        // copy half-done.
        const tmpPath = basePath + '.tmp' + process.pid;
        fs.writeFileSync(tmpPath, pngBuffer);
        fs.renameSync(tmpPath, basePath + '.png');
    }

    await hideOverlay(page);

    if (captureHtml && !fs.existsSync(basePath + '.body.html')) {
        try {
            const { body, head } = await page.evaluate(() => ({
                body: document.body.outerHTML.replace(/<path .*?<\/path>/g, ''),
                head: document.head.outerHTML,
            }));
            fs.writeFileSync(basePath + '.body.html', body, 'utf-8');
            fs.writeFileSync(basePath + '.head.html', head, 'utf-8');
        } catch { }
    }

    return hash;
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
                if (!screenshotsSuppressed()) {
                    await hideOverlay(actualPage);
                    await actualLocator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                    const box = await actualLocator.boundingBox().catch(() => null);
                    if (!box) {
                        throw new Error(failureText);
                    }
                    await showOverlayCheck(actualPage, box, short);
                    await takeScreenshot(actualPage, false, loc, stepStartTimeMs);
                }
                const result = await (actualLocator as any)[method](...args);
                pendingFailureText = '';
                return result;
            } catch (error: any) {
                await showOverlayBanner(actualPage, failureText, 'error');
                await takeScreenshot(actualPage, false, loc, stepStartTimeMs, true).catch(() => {});
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
            if (!screenshotsSuppressed()) {
                await showLocatorStepOverlay(actualLocator, actualPage, label, 'assert', 'info');
                await takeScreenshot(actualPage, false, loc, stepStartTimeMs);
            }
            pendingFailureText = '';
            return result;
        } catch (error: any) {
            await showLocatorStepOverlay(actualLocator, actualPage, failureText, 'assert', 'error');
            await takeScreenshot(actualPage, false, loc, stepStartTimeMs, true).catch(() => {});
            failureCaptured = true;
            throw error;
        }
    };

    wrapped.waitFor = async function (options?: any) {
        const loc = getCallerLocation();
        const stepStartTimeMs = Date.now();
        lastStepLocation = loc;
        await (actualLocator as any).waitFor(options);
        if (!screenshotsSuppressed()) {
            await showLocatorStepOverlay(actualLocator, actualPage, 'waitFor');
            await takeScreenshot(actualPage, false, loc, stepStartTimeMs);
        }
    };

    const inspectionMethods = ['textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked', 'isEditable'];
    for (const method of inspectionMethods) {
        wrapped[method] = async function (...args: any[]) {
            const loc = getCallerLocation();
            const stepStartTimeMs = Date.now();
            lastStepLocation = loc;
            const label = describeLocatorInspection(method, args);
            const failureText = `Locator ${actualLocator} failed ${label}`;
            pendingFailureText = failureText;
            try {
                const result = await (actualLocator as any)[method](...args);
                if (!screenshotsSuppressed()) {
                    await showLocatorStepOverlay(actualLocator, actualPage, label);
                    await takeScreenshot(actualPage, false, loc, stepStartTimeMs);
                }
                pendingFailureText = '';
                return result;
            } catch (error) {
                await showLocatorStepOverlay(actualLocator, actualPage, failureText, 'check', 'error');
                await takeScreenshot(actualPage, false, loc, stepStartTimeMs, true).catch(() => {});
                failureCaptured = true;
                throw error;
            }
        };
    }

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

function wrapPage(actualPage: Page): ShotestPage {
    const wrapped = Object.create(actualPage) as any;
    wrapped._shotestActualPage = actualPage;

    const locatorReturning = ['locator', 'getByText', 'getByRole', 'getByPlaceholder', 'getByLabel', 'getByTestId', 'getByAltText', 'getByTitle'];
    for (const method of locatorReturning) {
        wrapped[method] = function (...args: any[]) {
            const loc = (actualPage as any)[method](...args);
            return wrapLocator(loc, actualPage);
        };
    }

    wrapped.describe = function (text: string) {
        setPendingDescription(text);
    };

    wrapped.goto = async function (url: string, options: any) {
        const loc = getCallerLocation();
        lastStepLocation = loc;
        await actualPage.goto(url, options);
        if (!screenshotsSuppressed()) {
            queueOverlayBanner('goto ' + url, 'info');
        }
    };

    wrapped.waitForTimeout = async function (timeout: number) {
        const loc = getCallerLocation();
        const stepStartTimeMs = Date.now();
        lastStepLocation = loc;
        await actualPage.waitForTimeout(timeout);
        if (!screenshotsSuppressed()) {
            await hideOverlay(actualPage);
            await showOverlayBanner(actualPage, `waitForTimeout ${timeout}ms`, 'info');
            await takeScreenshot(actualPage, false, loc, stepStartTimeMs);
        }
    };

    return wrapped as ShotestPage;
}

// ── Test fixture ───────────────────────────────────────────────────

function getTestTitle(testInfo: TestInfo): string {
    // titlePath leads with the file name and (if set) project name — in an
    // order that has varied between Playwright versions — followed by the
    // describe blocks and the test title. Keep the describe blocks, so two
    // same-named tests in different describes stay distinct.
    const parts = testInfo.titlePath.filter(Boolean);
    while (parts.length > 1 && (parts[0] === testInfo.project.name || parts[0].endsWith(path.basename(testInfo.file)))) {
        parts.shift();
    }
    return parts.join(' › ') || testInfo.title;
}

export const test = baseTest.extend<{ page: ShotestPage }>({
    page: async ({ page }, use, testInfo) => {
        const actualPage = page;
        const videoMode = detectVideoMode(testInfo);

        // Playwright's per-test output dir sits directly under the root results
        // dir; the flat screenshot pool and spec JSONs live in that root.
        const outDir = testInfo.outputDir;
        const poolDir = path.dirname(outDir);
        currentPoolDir = poolDir;
        currentSteps = [];
        lastStepLocation = null;
        pendingFailureText = '';
        pendingOverlayNotices = [];
        pendingConsoleMessages = [];
        pendingDescription = undefined;
        suppressDepth = 0;
        failureCaptured = false;

        fs.mkdirSync(poolDir, { recursive: true });

        // Set video mode flag and inject appropriate CSS
        await actualPage.addInitScript(({ isVideoMode, videoCss, overlayCss }: { isVideoMode: boolean; videoCss: string; overlayCss: string }) => {
            (window as any).__VIDEO_MODE__ = isVideoMode;
            const style = document.createElement('style');
            if (isVideoMode) {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                style.textContent = videoCss;
            } else {
                style.textContent = overlayCss;

                // The `scroll-behavior: auto !important` in that CSS only governs
                // scrolls that don't name a behavior themselves — an explicit
                // `el.scrollBy({behavior: 'smooth'})` beats the stylesheet and
                // animates anyway. Such a scroll keeps running under the assertion
                // that follows it, so the screenshot catches the scroller wherever
                // the animation had got to. Rewrite the request to an instant one.
                const instant = (options: unknown) =>
                    options && typeof options === 'object' ? { ...options, behavior: 'instant' } : options;
                for (const target of [Element.prototype, window] as any[]) {
                    for (const name of ['scroll', 'scrollTo', 'scrollBy']) {
                        const original = target[name];
                        if (typeof original !== 'function') continue;
                        target[name] = function (this: unknown, ...args: unknown[]) {
                            // Only the options form carries a behavior; `scrollTo(x, y)`
                            // takes its cue from the CSS, which is already instant.
                            return original.apply(this, args.length === 1 ? [instant(args[0])] : args);
                        };
                    }
                }
                const scrollIntoView = Element.prototype.scrollIntoView;
                Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
                    // `scrollIntoView(true|false|undefined)` defers to the CSS too.
                    return scrollIntoView.call(this, instant(arg) as ScrollIntoViewOptions);
                };
            }
            if (document.head) document.head.appendChild(style);
            else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
        }, { isVideoMode: videoMode, videoCss: VIDEO_INIT_CSS, overlayCss: OVERLAY_STYLE });

        actualPage.on('console', (msg) => {
            const text = stripAnsi(msg.text());
            const type = msg.type();
            recordConsoleMessage({
                type,
                text,
                source: normalizeConsoleSource(msg.location()),
            });
            console.log(`Browser ${type}: ${text}`);
        });
        actualPage.on('pageerror', (err) => {
            const text = stripAnsi(String(err.stack || err.message || err));
            recordConsoleMessage({ type: 'error', text });
            console.error('BROWSER ERROR:', text);
        });

        if (videoMode) {
            // No wrapping in video mode, but page.describe() must still exist
            // (as a no-op) so scripts run unchanged.
            const veneer = Object.create(actualPage) as any;
            veneer.describe = () => { };
            await use(veneer as ShotestPage);
        } else {
            const wrappedPage = wrapPage(actualPage);
            await use(wrappedPage);
        }

        // Console messages never trigger a screenshot. The screenshot set must be a
        // function of the test's actions alone: a console message can arrive at any
        // moment (e.g. a framework's perf-timing debug log fired by the last action's
        // reactive update — more likely under load), so screenshotting on one would
        // make the frame set flaky. Any messages still pending after the final action
        // are folded into the last step's metadata so they aren't lost from the report.
        const trailingMessages = drainPendingConsoleMessages();
        const lastImageStep = [...currentSteps].reverse().find((step) => !('gap' in step));
        if (trailingMessages && lastImageStep && 'image' in lastImageStep) {
            lastImageStep.consoleMessages = [...(lastImageStep.consoleMessages ?? []), ...trailingMessages];
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
                await takeScreenshot(actualPage, true, failureLoc, Date.now(), true).catch(() => {});
            }

            let currentUrl = '';
            try { currentUrl = actualPage.url(); } catch { currentUrl = 'unavailable'; }

            fs.mkdirSync(outDir, { recursive: true });
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

        const record: TestRecord = {
            file: path.relative(process.cwd(), testInfo.file),
            title: getTestTitle(testInfo),
            line: testInfo.line,
            status: testInfo.status || 'unknown',
            duration: testInfo.duration,
            error: errorMessage,
            errorSource: errorSource,
            errorStack: errorStack,
            steps: currentSteps,
        };
        mergeTestRecord(poolDir, record);
    },
});
