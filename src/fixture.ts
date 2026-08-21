import { test as baseTest, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { stripPngMetadata } from './png.js';
import { hashImagePixels } from './hash.js';
import { mergeTestRecord, type StepEventRecord, type StepRecord, type TestRecord } from './manifest.js';

export { expect };
export type { Page };
export type { StepEventRecord, StepRecord, TestRecord };

/** The page handed to tests: Playwright's Page plus ShoTest's describe(). */
export interface ShotestPage extends Page {
    /**
     * Attach a one-line hint to what happens next; the review tool shows it
     * as a header above the following events in the step's event list.
     */
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



// ── Deterministic rasterization ────────────────────────────────────

// Screenshot comparison is exact, so rendering must be a pure function of the
// page — but stock Chromium trades exactness for speed in ways that leak
// frame-timing into the pixels. The proven one: partial raster re-rasterizes
// only the damaged rect into a cached tile, and anti-aliased edges crossing
// the damage boundary come out ±1–6/255 different from a full raster —
// whether a given capture gets the partial or the full version depends on
// how invalidations landed in frames, i.e. on timing. The rest of the set
// pins other environment-dependent inputs, following Chromium's own pixel
// tests: checker-imaging rasters a placeholder while an image decodes
// (decode timing → pixels), image-animation resync ties animated images to
// the wall clock, Skia runtime opts pick SIMD code paths by CPUID (two
// machines, same container image, different pixels), and the color profile
// converts every color through whatever the host claims to display.
const CHROMIUM_DETERMINISM_ARGS = [
    '--disable-partial-raster',
    '--disable-checker-imaging',
    '--disable-image-animation-resync',
    '--disable-skia-runtime-opts',
    '--force-color-profile=srgb',
];

// ── Stability CSS ──────────────────────────────────────────────────

// Nothing is ever injected into the page for screenshots themselves — they
// are clean captures, and what happened (clicks, assertions) is recorded as
// step events in the spec JSON instead. This stylesheet only pins the page
// down visually: no animations, no smooth scrolling.
// Note that `*` (and `*::before`/`*::after`) reaches no other pseudo-elements:
// a transition declared on `::details-content` (a <details> unfold) or
// `::backdrop` (a <dialog> fade) sails right past the universal rule and
// animates anyway. Those get rules of their own — and *separate* rules, not
// extra items in the selector list, because a browser that doesn't know a
// pseudo-element drops the whole rule it appears in, which would silently
// re-enable every animation on the page.
const STABILITY_STYLE = `
    html, body, * {
        scroll-behavior: auto !important;
    }
    *, *::before, *::after {
        transition: none !important;
        animation: none !important;
    }
    *::details-content {
        transition: none !important;
        animation: none !important;
    }
    *::backdrop {
        transition: none !important;
        animation: none !important;
    }
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

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// ── Step events ────────────────────────────────────────────────────

type EventBox = NonNullable<StepEventRecord['box']>;

function roundBox(box: EventBox): EventBox {
    return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
    };
}

function makeEvent(type: StepEventRecord['type'], message: string, loc: SourceLocation, box?: EventBox | null): StepEventRecord {
    return {
        type,
        message: stripAnsi(message),
        box: box ? roundBox(box) : undefined,
        source: `${path.relative(process.cwd(), loc.file)}:${loc.line}`,
    };
}

/**
 * Locate the element an event is about, scrolled into view so it shows in the
 * screenshot. The underlying operation has already completed here, so the
 * element is either present now or never will be (e.g. after a successful
 * negative assertion like not.toBeVisible). A bounded wait keeps the absent
 * case from stalling for the full default timeout; the event then simply
 * carries no box.
 */
async function locatorEventBox(locator: Locator): Promise<EventBox | null> {
    await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    return await locator.boundingBox({ timeout: 1000 }).catch(() => null);
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** The expected value(s) an expect() carried, e.g. `"Welcome"`, `/\d+/`, `3`. */
function formatExpected(options: any): string {
    if (Array.isArray(options?.expectedText)) {
        return options.expectedText
            .map((value: { string?: string; regexSource?: string; regexFlags?: string }) =>
                value.regexSource !== undefined
                    ? `/${value.regexSource}/${value.regexFlags ?? ''}`
                    : JSON.stringify(value.string ?? ''))
            .join(', ');
    }
    if (typeof options?.expectedNumber === 'number') return String(options.expectedNumber);
    return '';
}

/**
 * A one-line label for a passed expect(), e.g. 'expect not visible' or
 * `expect text "Welcome"` — built from Playwright's internal expression
 * ("to.have.text") plus the negation flag and expected values it passes along.
 */
function describeExpectation(method: string, options: any): string {
    // "to.have.attribute.value" → "attribute value"; the ".array" suffix says
    // nothing the listed values don't.
    let what = method.replace(/\.array$/, '').replace(/^to\.(?:be\.|have\.|contain\.)?/, '').replace(/\./g, ' ');
    // toBeChecked() folds its variants into options rather than the method.
    if (method === 'to.be.checked') {
        if (options?.expectedValue?.indeterminate) what = 'indeterminate';
        else if (options?.expectedValue?.checked === false) what = 'unchecked';
    }
    let label = `expect ${options?.isNot ? 'not ' : ''}${what}`;
    // The attribute/CSS-property name for toHaveAttribute(name, ...) etc.
    if (typeof options?.expressionArg === 'string') label += ' ' + JSON.stringify(options.expressionArg);
    const expected = formatExpected(options);
    if (expected) label += ' ' + truncate(expected, 100);
    return label;
}

/**
 * With no box to point at the element (typical for a passed negative
 * assertion — the element is hidden or gone), name the target in the message
 * instead, so the event row still says what it was about.
 */
function withTarget(message: string, box: EventBox | null, locator: Locator): string {
    return box ? message : `${message} (${truncate(String(locator), 80)})`;
}

function describeLocatorInspection(method: string, args: any[]): string {
    if (method === 'getAttribute' && typeof args[0] === 'string') {
        return `getAttribute ${JSON.stringify(args[0])}`;
    }
    return method;
}

// ── Screenshot capture ─────────────────────────────────────────────

let currentPoolDir = '';
let currentSteps: StepRecord[] = [];
let lastStepLocation: SourceLocation | null = null;
let pendingFailureText = '';
// Events waiting for the next capture to attach to (e.g. a page-level command
// like goto, which by itself does not screenshot: the frame right after it is
// rarely interesting, and the next step shows where it led).
let pendingEvents: StepEventRecord[] = [];
// Positive: inside suppressScreenshots. forceScreenshots subtracts a million,
// so within it the depth stays negative no matter how many suppress blocks
// are entered — force wins regardless of nesting order.
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

// Console output rides the same pending queue as goto/describe, so it lands
// in a step's event list right between the events it arrived between.
function recordConsoleEvent(consoleType: string, text: string, source?: string): void {
    pendingEvents.push({ type: 'console', consoleType, message: text, source });
}

/**
 * Run `fn` without producing screenshots for the wrapped actions and
 * assertions, recording a single placeholder ("gap") step with the given
 * one-line description instead. Use it for routine flows that reoccur across
 * many tests (logging in, seeding data) to keep reviews focused — it also
 * skips the stability and capture work, so the wrapped part runs faster.
 *
 * A failure inside the block still captures an error screenshot, and explicit
 * `screenshot(page, name)` calls and forceScreenshots() blocks still capture.
 */
export async function suppressScreenshots<T>(description: string, fn: () => Promise<T> | T): Promise<T> {
    // Only push the gap placeholder when this call actually turns capture
    // off: inside forceScreenshots (depth negative) suppression is inert,
    // and real screenshots will document the block instead.
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

/**
 * Run `fn` with screenshots always captured, overriding suppressScreenshots()
 * blocks around it and within it alike. The common use is wrapping a helper
 * that suppresses its own screenshots (logging in, seeding data), in the one
 * test where that routine flow is the actual functionality under test.
 */
export async function forceScreenshots<T>(fn: () => Promise<T> | T): Promise<T> {
    suppressDepth -= 1000000;
    try {
        return await fn();
    } finally {
        suppressDepth += 1000000;
    }
}

async function takeScreenshot(
    actualPage: Page,
    event: StepEventRecord | null,
    alreadyStable: boolean = false,
    stepStartTimeMs: number = Date.now(),
    force: boolean = false,
): Promise<void> {
    if (screenshotsSuppressed() && !force) return;

    if (!alreadyStable) {
        await waitForVisualStability(actualPage);
    }

    const hash = await captureStep(actualPage);
    if (!hash) return; // page closed (e.g. test timed out) — keep pending events queued

    if (event) event.duration = Math.max(0, Date.now() - stepStartTimeMs);
    const events = pendingEvents;
    pendingEvents = [];
    if (event) events.push(event);
    appendStep(actualPage, hash, events);
}

/**
 * Record a captured frame as a step. Consecutive captures of an unchanged
 * page hash identically; their events are folded onto the existing step, so
 * a run of checks (usually ending with the action that changes the page)
 * shows as one screenshot with a list of events in the review app.
 */
function appendStep(actualPage: Page, hash: string, events: StepEventRecord[]): void {
    const role = getPageRole(actualPage);
    const last = currentSteps[currentSteps.length - 1];

    if (last && !('gap' in last) && last.image === hash && last.role === role) {
        if (events.length > 0) last.events = [...(last.events ?? []), ...events];
        return;
    }

    currentSteps.push({
        image: hash,
        viewport: actualPage.viewportSize() ?? undefined,
        events: events.length > 0 ? events : undefined,
        role,
    });
}

/**
 * Take an explicitly named screenshot, recorded as a 'screenshot' event
 * carrying the name. If the page looks the same as the previous step, the
 * event simply joins that step's list. Captures even inside a
 * suppressScreenshots() block.
 */
export async function screenshot(page: Page, name: string): Promise<void> {
    await takeScreenshot(page, makeEvent('screenshot', name, getCallerLocation()), false, Date.now(), true);
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
        // The stability stylesheet can't reach Web-Animations-API animations
        // (element.animate() knows no CSS); this finishes those before the
        // shot — finite ones jump to their end state, infinite ones are
        // canceled — so a mid-flight frame can't wobble the pixels.
        pngBuffer = await page.screenshot({ fullPage: false, animations: 'disabled' });
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
                    // Capture *before* the action runs: the shot shows the
                    // page the action found, with the event box marking what
                    // it targeted. The action's effect shows in the next step.
                    await actualLocator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                    const box = await actualLocator.boundingBox().catch(() => null);
                    if (!box) {
                        throw new Error(failureText);
                    }
                    await takeScreenshot(actualPage, makeEvent('action', short, loc, box), false, stepStartTimeMs);
                }
                const result = await (actualLocator as any)[method](...args);
                pendingFailureText = '';
                return result;
            } catch (error: any) {
                await takeScreenshot(actualPage, makeEvent('error', failureText, loc), false, stepStartTimeMs, true).catch(() => {});
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
        const label = describeExpectation(method, options);
        const failureText = `${label} failed`;
        pendingFailureText = failureText;
        try {
            const result = await (actualLocator as any)._expect(method, options);
            if (!screenshotsSuppressed()) {
                const box = await locatorEventBox(actualLocator);
                await takeScreenshot(actualPage, makeEvent('assert', withTarget(label, box, actualLocator), loc, box), false, stepStartTimeMs);
            }
            pendingFailureText = '';
            return result;
        } catch (error: any) {
            const box = await locatorEventBox(actualLocator);
            await takeScreenshot(actualPage, makeEvent('error', withTarget(failureText, box, actualLocator), loc, box), false, stepStartTimeMs, true).catch(() => {});
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
            const box = await locatorEventBox(actualLocator);
            const label = options?.state ? `waitFor ${options.state}` : 'waitFor';
            await takeScreenshot(actualPage, makeEvent('check', withTarget(label, box, actualLocator), loc, box), false, stepStartTimeMs);
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
                    const box = await locatorEventBox(actualLocator);
                    await takeScreenshot(actualPage, makeEvent('check', withTarget(label, box, actualLocator), loc, box), false, stepStartTimeMs);
                }
                pendingFailureText = '';
                return result;
            } catch (error) {
                const box = await locatorEventBox(actualLocator);
                await takeScreenshot(actualPage, makeEvent('error', failureText, loc, box), false, stepStartTimeMs, true).catch(() => {});
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
        // A pending event, like goto: it attaches to the next capture, right
        // before the events that follow it — which is where the header
        // belongs, even when that capture merges into the previous step.
        pendingEvents.push(makeEvent('describe', String(text), getCallerLocation()));
    };

    // Page-level commands (navigation, viewport) take no screenshot of their
    // own: the frame right after them is rarely interesting, and the next
    // primitive's capture shows where they led. Each queues a pending 'page'
    // event that lands beneath that capture — reading as "how the page got
    // here", which is why the review app renders these rows dimmed.
    const pageCommands: Record<string, (args: any[]) => string> = {
        goto: (args) => 'goto ' + args[0],
        reload: () => 'reload',
        goBack: () => 'goBack',
        goForward: () => 'goForward',
        setViewportSize: (args) => `setViewportSize ${args[0]?.width}×${args[0]?.height}`,
    };
    for (const [method, message] of Object.entries(pageCommands)) {
        wrapped[method] = async function (...args: any[]) {
            const loc = getCallerLocation();
            lastStepLocation = loc;
            const result = await (actualPage as any)[method](...args);
            if (!screenshotsSuppressed()) {
                pendingEvents.push(makeEvent('page', message(args), loc));
            }
            return result;
        };
    }

    wrapped.waitForTimeout = async function (timeout: number) {
        const loc = getCallerLocation();
        const stepStartTimeMs = Date.now();
        lastStepLocation = loc;
        await actualPage.waitForTimeout(timeout);
        if (!screenshotsSuppressed()) {
            await takeScreenshot(actualPage, makeEvent('wait', `waitForTimeout ${timeout}ms`, loc), false, stepStartTimeMs);
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
    // Injected here rather than through defineConfig so it lands after all
    // config/project merging, and only for the browser it belongs to.
    launchOptions: [async ({ launchOptions, browserName }, use) => {
        if (browserName === 'chromium') {
            await use({ ...launchOptions, args: [...(launchOptions.args ?? []), ...CHROMIUM_DETERMINISM_ARGS] });
        } else {
            await use(launchOptions);
        }
    }, { scope: 'worker' }],
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
        pendingEvents = [];
        suppressDepth = 0;
        failureCaptured = false;

        fs.mkdirSync(poolDir, { recursive: true });

        // Set video mode flag and inject appropriate CSS
        await actualPage.addInitScript(({ isVideoMode, videoCss, stabilityCss }: { isVideoMode: boolean; videoCss: string; stabilityCss: string }) => {
            (window as any).__VIDEO_MODE__ = isVideoMode;
            const style = document.createElement('style');
            if (isVideoMode) {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                style.textContent = videoCss;
            } else {
                style.textContent = stabilityCss;

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
        }, { isVideoMode: videoMode, videoCss: VIDEO_INIT_CSS, stabilityCss: STABILITY_STYLE });

        actualPage.on('console', (msg) => {
            const text = stripAnsi(msg.text());
            const type = msg.type();
            recordConsoleEvent(type, text, normalizeConsoleSource(msg.location()));
            console.log(`Browser ${type}: ${text}`);
        });
        actualPage.on('pageerror', (err) => {
            const text = stripAnsi(String(err.stack || err.message || err));
            recordConsoleEvent('error', text);
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

        // Console output never triggers a screenshot. The screenshot set must be a
        // function of the test's actions alone: a console message can arrive at any
        // moment (e.g. a framework's perf-timing debug log fired by the last action's
        // reactive update — more likely under load), so screenshotting on one would
        // make the frame set flaky. Any events still pending after the final capture
        // (trailing console output, or a page command like goto with nothing after
        // it) are folded into the last step so they aren't lost from the report.
        const lastImageStep = [...currentSteps].reverse().find((step) => !('gap' in step));
        if (pendingEvents.length > 0 && lastImageStep && 'image' in lastImageStep) {
            lastImageStep.events = [...(lastImageStep.events ?? []), ...pendingEvents];
        }
        pendingEvents = [];

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
                await takeScreenshot(actualPage, makeEvent('error', errorMessage, failureLoc), true, Date.now(), true).catch(() => {});
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
