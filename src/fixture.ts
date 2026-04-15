import { test as baseTest, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { stripPngMetadata } from './png.js';

export { expect };
export type { Page };

// ── Configuration ──────────────────────────────────────────────────

export interface ShoTestConfig {
    /** Directory for test output (default: "test-results") */
    outputDir: string;
    /** Directory for accepted/expected screenshots (default: "test-accepted") */
    expectedDir: string;
    /** Capture DOM HTML alongside screenshots (default: true) */
    captureHtml: boolean;
    /** Strip PNG metadata for consistent output (default: true) */
    stripMetadata: boolean;
}

const config: ShoTestConfig = {
    outputDir: process.env.SHOTEST_OUTPUT_DIR || 'test-results',
    expectedDir: process.env.SHOTEST_EXPECTED_DIR || 'test-accepted',
    captureHtml: process.env.SHOTEST_CAPTURE_HTML !== 'false',
    stripMetadata: process.env.SHOTEST_STRIP_METADATA !== 'false',
};

export function configure(overrides: Partial<ShoTestConfig>): void {
    Object.assign(config, overrides);
}

// ── Stack trace helpers ────────────────────────────────────────────

function getCallerLocation(): { file: string; line: number } {
    const stack = new Error().stack || '';
    const frames = stack.split('\n');
    // Look for test/spec files
    for (const frame of frames) {
        const match = frame.match(/([^\s(]+\.(spec|test)\.[jt]sx?):(\d+):\d+/);
        if (match) {
            let file = match[1];
            // Strip file:// URL prefix if present
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
    return { file: 'unknown', line: 0 };
}

// ── Overlay helpers ────────────────────────────────────────────────

const OVERLAY_STYLE = `
    *, *::before, *::after { transition: none !important; animation: none !important; }
    .fadeOut, .fadeOut * { pointer-events: none !important; visibility: hidden !important; }
    #shotest-overlay.check,
    #shotest-overlay.assert {
        position: fixed;
        border-radius: 8px;
        border-bottom-left-radius: 0;
        pointer-events: none;
        z-index: 1000000;
    }
    #shotest-overlay.check {
        border: 2px solid #28a745;
        background: rgba(40, 167, 69, 0.2);
    }
    #shotest-overlay.assert {
        border: 2px solid #4fc1ff;
        background: rgba(79, 193, 255, 0.2);
    }
    #shotest-overlay.check > p,
    #shotest-overlay.assert > p {
        position: absolute;
        top: 100%;
        left: -2px;
        color: black;
        padding: 2px 6px;
        border-radius: 3px;
        border-top-left-radius: 0;
        font-size: 12px; white-space: nowrap; font-family: sans-serif;
    }
    #shotest-overlay.check > p { background: #28a745; }
    #shotest-overlay.assert > p { background: #4fc1ff; }
    #shotest-overlay.banner {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 10px 20px;
        font-family: sans-serif;
        font-size: 14px;
        z-index: 1000002;
        border-top: 2px solid #333;
        white-space: pre-wrap;
    }
    #shotest-overlay.banner.error { border-top-color: red !important; background: rgba(80, 0, 0, 0.9) !important; }
    #shotest-overlay.banner.info { border-top-color: #007acc !important; }
    #shotest-overlay.banner.success { border-top-color: #28a745 !important; }
`;

async function waitForRepaint(page: Page) {
    await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ));
}

async function hideOverlay(page: Page) {
    await page.evaluate(() => {
        const el = document.getElementById("shotest-overlay");
        if (el) el.remove();
    });
}

async function showOverlayCheck(page: Page, box: { x: number; y: number; width: number; height: number }, text?: string, kind: 'check' | 'assert' = 'check') {
    await page.evaluate(({ x, y, w, h, text, kind }) => {
        const el = document.createElement('div');
        el.id = 'shotest-overlay';
        el.className = kind;
        document.body.appendChild(el);
        Object.assign(el.style, {
            left: (x - 4) + 'px',
            top: (y - 4) + 'px',
            width: (w + 8) + 'px',
            height: (h + 8) + 'px',
        });
        if (text) {
            const p = document.createElement('p');
            p.innerText = text;
            el.appendChild(p);
        }
    }, { x: box.x, y: box.y, w: box.width, h: box.height, text, kind });
}

async function showOverlayBanner(page: Page, text: string, type: 'info' | 'error' | 'success' = 'info') {
    if (type === 'error') console.error(text);
    await page.evaluate(({ text, type }) => {
        const el = document.createElement('div');
        el.id = 'shotest-overlay';
        el.className = 'banner ' + type;
        document.body.appendChild(el);
        el.textContent = text;
    }, { text, type });
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
}

export interface TestManifest {
    file: string;
    title: string;
    line: number;
    status: string;
    duration: number;
    error: string | null;
    steps: StepInfo[];
}

let currentOutDir = '';
let currentSteps: StepInfo[] = [];
let lastScreenshotKey = '';
let lastScreenshotSeq = 0;

async function takeScreenshot(actualPage: Page) {
    const loc = getCallerLocation();
    const key = currentOutDir + ':' + loc.line;
    if (lastScreenshotKey !== key) {
        lastScreenshotKey = key;
        lastScreenshotSeq = 0;
    } else {
        lastScreenshotSeq++;
    }

    await waitForRepaint(actualPage);

    const name = `${loc.line.toString().padStart(4, '0')}${String.fromCharCode(97 + lastScreenshotSeq)}`;
    const basePath = path.join(currentOutDir, name);
    const relFile = path.relative(process.cwd(), loc.file);

    await captureStep(basePath, actualPage);
    currentSteps.push({ name, source: `${relFile}:${loc.line}` });
}

/**
 * Take a named screenshot (clean, no overlay). Useful for promotional material.
 */
export async function screenshot(page: Page, name: string): Promise<void> {
    await waitForRepaint(page);
    const basePath = path.join(currentOutDir, name);
    const loc = getCallerLocation();
    const relFile = path.relative(process.cwd(), loc.file);

    // Capture without overlay
    await hideOverlay(page);
    await captureStep(basePath, page);
    currentSteps.push({ name, source: `${relFile}:${loc.line}` });
}

async function captureStep(basePath: string, page: Page): Promise<void> {
    // Capture screenshot
    let pngBuffer = await page.screenshot({ fullPage: true });
    if (config.stripMetadata) {
        pngBuffer = stripPngMetadata(pngBuffer);
    }
    fs.writeFileSync(basePath + '.png', pngBuffer);

    // Remove overlay before capturing HTML
    await hideOverlay(page);

    if (config.captureHtml) {
        const { body, head } = await page.evaluate(() => ({
            body: document.body.outerHTML.replace(/<path .*?<\/path>/g, ''),
            head: document.head.outerHTML,
        }));
        fs.writeFileSync(basePath + '.body.html', body, 'utf-8');
        fs.writeFileSync(basePath + '.head.html', head, 'utf-8');
    }
}

// ── Locator wrapping ───────────────────────────────────────────────

function wrapLocator(actualLocator: Locator, actualPage: Page): Locator {
    const wrapped = Object.create(actualLocator) as any;

    const actionMethods = ['click', 'fill', 'type', 'press', 'check', 'uncheck', 'selectOption', 'hover', 'dblclick', 'clear'];
    for (const method of actionMethods) {
        wrapped[method] = async function (...args: any[]) {
            const short = typeof args[0] === 'string' ? method + ' ' + JSON.stringify(args[0]) : method;
            try {
                const box = await actualLocator.boundingBox({ timeout: 3000 }).catch(() => null);
                if (!box) {
                    await showOverlayBanner(actualPage, `Cannot find ${actualLocator} for ${short}`, 'info');
                } else {
                    await showOverlayCheck(actualPage, box, short);
                }
                await takeScreenshot(actualPage);
                return await (actualLocator as any)[method](...args);
            } catch (error: any) {
                await showOverlayBanner(actualPage, `Locator ${actualLocator} failed ${short}`, 'error');
                await takeScreenshot(actualPage);
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
        const label = describeExpectation(method);
        try {
            const result = await (actualLocator as any)._expect(method, options);
            const box = await actualLocator.boundingBox({ timeout: 1000 }).catch(() => null);
            if (box) {
                await showOverlayCheck(actualPage, box, label, 'assert');
            } else {
                await showOverlayBanner(actualPage, label, 'info');
            }
            await takeScreenshot(actualPage);
            return result;
        } catch (error: any) {
            const box = await actualLocator.boundingBox({ timeout: 500 }).catch(() => null);
            if (box) {
                await showOverlayCheck(actualPage, box, `${label} failed`, 'assert');
            } else {
                await showOverlayBanner(actualPage, `${label} failed`, 'error');
            }
            await takeScreenshot(actualPage);
            throw error;
        }
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
        await actualPage.goto(url, options);
        await actualPage.waitForLoadState('load').catch(() => { });
        await actualPage.addStyleTag({ content: OVERLAY_STYLE });
        await showOverlayBanner(actualPage, 'goto ' + url, 'info');
        await takeScreenshot(actualPage);
    };

    return wrapped;
}

// ── Test fixture ───────────────────────────────────────────────────

export const test = baseTest.extend({
    page: async ({ page }, use, testInfo) => {
        const actualPage = page;

        // Build output directory
        const baseName = path.basename(testInfo.file, path.extname(testInfo.file)).replace(/\.spec$|\.test$/, '');
        const dirName = `${baseName}-${testInfo.line.toString().padStart(4, '0')}`;
        const outDir = path.join(config.outputDir, dirName);
        currentOutDir = outDir;
        currentSteps = [];
        lastScreenshotKey = '';
        lastScreenshotSeq = 0;

        fs.mkdirSync(outDir, { recursive: true });

        actualPage.on('console', (...args: any[]) => console.log('Browser:', ...args));
        actualPage.on('pageerror', err => console.error('BROWSER ERROR:', err.message));

        const wrappedPage = wrapPage(actualPage);
        await use(wrappedPage);

        // Capture failure state
        if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
            await captureStep(path.join(outDir, 'error'), actualPage);

            let errorInfo = `Test: ${testInfo.title}\n`;
            errorInfo += `Status: ${testInfo.status}\n`;
            errorInfo += `Current URL: ${actualPage.url()}\n`;
            errorInfo += `Duration: ${testInfo.duration}ms\n\n`;
            if (testInfo.error) {
                errorInfo += `Error:\n${testInfo.error.stack || testInfo.error.message}\n\n`;
            }
            fs.writeFileSync(path.join(outDir, 'error.txt'), errorInfo, 'utf-8');
        }

        // Write manifest
        const manifest: TestManifest = {
            file: path.relative(process.cwd(), testInfo.file),
            title: testInfo.title,
            line: testInfo.line,
            status: testInfo.status || 'unknown',
            duration: testInfo.duration,
            error: testInfo.error ? (testInfo.error.stack || testInfo.error.message || null) : null,
            steps: currentSteps,
        };
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    },
});
