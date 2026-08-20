/**
 * The ShoTest on-disk data model, shared by the fixture (writer), the
 * review server, and the CLI (gc).
 *
 * Both test-results/ and test-accepted/ are flat:
 *   <spec-base>.json   one file per spec file, listing its tests and steps
 *   <hash>.png|.webp   screenshots, named by pixel-content hash (see hash.ts)
 *   <hash>.body.html   DOM snapshots (test-results only, when enabled)
 *
 * Screenshots are clean captures of the page; what happened at each moment
 * (clicks, assertions, navigations) is recorded as *events* on the step, with
 * the viewport box of the element involved. Steps reference images by hash,
 * so multiple tests and steps can share one pool file; `shotest gc` removes
 * pool files no JSON references anymore.
 */

import * as fs from 'fs';
import * as path from 'path';
import { POOL_FILE_RE } from './hash.js';

/**
 * The spec JSON format version. Bumped whenever the step shape changes in a
 * way older readers (or this reader, for older files) cannot handle; files
 * carrying another version — including the versionless pre-event format —
 * are ignored, so their tests read as "no data yet".
 */
export const SPEC_VERSION = 3;

/**
 * Something that happened while the page looked like the step's screenshot.
 *
 * Events are display data only: whether a test changed is decided purely from
 * its screenshots (and gap texts) — see entriesEquivalent in review.ts. If
 * the pictures match and the test is green, all is well, no matter how it
 * got there; when the event lists do differ, the review app lets the
 * reviewer flip an unchanged step between its accepted and current lists.
 */
export interface StepEventRecord {
    /**
     * action: a wrapped locator action (click, fill, ...), captured just
     *   before it ran — its effect shows in the *next* screenshot.
     * assert: a passed expect() assertion.
     * check: a passive read (textContent, waitFor, isVisible, ...).
     * page: a page-level command that captures no screenshot of its own
     *   (goto, reload, goBack, goForward, setViewportSize) — it queues and
     *   lands under the next capture, reading as how the page got there.
     * wait: page.waitForTimeout.
     * describe: a hint set via page.describe(...), shown by the review app
     *   as a header above the events that follow it.
     * screenshot: an explicit screenshot(page, name) call; the message is
     *   the given name.
     * console: a browser console message or page error. Ambient — its timing
     *   shifts run to run.
     * error: the failure a test ended on.
     */
    type: 'action' | 'assert' | 'check' | 'page' | 'wait' | 'describe' | 'screenshot' | 'console' | 'error';
    /** One-line summary, e.g. 'click "Submit"' or 'expect text'. */
    message: string;
    /** CSS-pixel box of the element involved, relative to the viewport. */
    box?: { x: number; y: number; width: number; height: number };
    /**
     * Source location, like "tests/my.spec.ts:10". For console events this
     * is the emitting browser source instead.
     */
    source?: string;
    /** Time spent on this event in milliseconds. */
    duration?: number;
    /** The browser console level (log, info, warning, error, ...). Console events only. */
    consoleType?: string;
}

/** A screenshot step: one clean capture plus the events that happened on it. */
export interface ImageStepRecord {
    /** Pixel-content hash naming the pool file (extension resolved at read time). */
    image: string;
    /** CSS-pixel viewport size, for mapping event boxes onto the image. */
    viewport?: { width: number; height: number };
    /**
     * What happened while the page looked like this, in order. Consecutive
     * events whose captures hashed identically are folded into one step, so a
     * run of checks on an unchanged page shares a single screenshot.
     */
    events?: StepEventRecord[];
    /** Role name assigned via splitIntoRoles(page, ...). */
    role?: string;
}

/** A placeholder for steps that ran without screenshots (withoutScreenshots). */
export interface GapStepRecord {
    gap: string;
}

export type StepRecord = ImageStepRecord | GapStepRecord;

export function isGapStep(step: StepRecord): step is GapStepRecord {
    return typeof (step as GapStepRecord).gap === 'string';
}

export interface TestRecord {
    /** Spec file path relative to the project root. */
    file: string;
    /** Full test title (describe-block titles joined with ' › '). */
    title: string;
    line?: number;
    status?: string;
    duration?: number;
    error?: string | null;
    errorSource?: string | null;
    errorStack?: string | null;
    steps: StepRecord[];
}

export interface SpecRecords {
    version: number;
    tests: TestRecord[];
}

// ── Spec JSON files ────────────────────────────────────────────────

/** "tests/my.spec.ts" → "my.spec.json" */
export function specJsonName(specFile: string): string {
    const base = path.basename(specFile);
    return base.replace(/\.[cm]?[jt]sx?$/, '') + '.json';
}

export function listSpecJsonFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((file) => file.endsWith('.json') && !file.startsWith('.')).sort();
}

/**
 * Read a spec JSON, or null when it is unreadable *or from another format
 * version*. Old-format files thus act as if their tests never existed —
 * accepting a test rebuilds its spec file from scratch (see mergeTestRecord)
 * and gc drops the images only the old file referenced.
 */
export function readSpecRecords(jsonPath: string): SpecRecords | null {
    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (data?.version === SPEC_VERSION && Array.isArray(data?.tests)) return data as SpecRecords;
    } catch { }
    return null;
}

/** Whether a spec JSON exists but was ignored by readSpecRecords (old format). */
export function isOutdatedSpecJson(jsonPath: string): boolean {
    return fs.existsSync(jsonPath) && readSpecRecords(jsonPath) === null;
}

export function writeSpecRecords(jsonPath: string, records: SpecRecords): void {
    // Atomic replace, so a concurrent reader never sees a torn file.
    const tmpPath = jsonPath + '.tmp' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, jsonPath);
}

function testKey(record: Pick<TestRecord, 'file' | 'title'>): string {
    return record.file + '\0' + record.title;
}

/**
 * Insert or replace one test's record in its spec JSON. Safe across Playwright
 * worker processes: guarded by an on-disk lock around the read-modify-write.
 */
export function mergeTestRecord(dir: string, record: TestRecord): void {
    fs.mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, specJsonName(record.file));
    withFileLock(jsonPath, () => {
        // An unreadable or old-format file is discarded wholesale: its records
        // could not be read as baselines anyway, and mixing formats in one
        // file would leave it unreadable forever.
        const records = readSpecRecords(jsonPath) ?? { version: SPEC_VERSION, tests: [] };
        const index = records.tests.findIndex((test) => testKey(test) === testKey(record));
        if (index >= 0) records.tests[index] = record;
        else records.tests.push(record);
        records.tests.sort((a, b) =>
            a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title));
        writeSpecRecords(jsonPath, records);
    });
}

// ── Cross-process file lock ────────────────────────────────────────

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10_000;

export function withFileLock<T>(filePath: string, fn: () => T): T {
    const lockDir = filePath + '.lock';
    const deadline = Date.now() + LOCK_STALE_MS;
    for (; ;) {
        try {
            fs.mkdirSync(lockDir);
            break;
        } catch {
            // Steal locks abandoned by a crashed worker.
            try {
                if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
                    fs.rmdirSync(lockDir);
                    continue;
                }
            } catch { continue; } // lock vanished between mkdir and stat: retry
            if (Date.now() > deadline) {
                throw new Error(`ShoTest: timed out waiting for lock ${lockDir}`);
            }
            sleepSync(25);
        }
    }
    try {
        return fn();
    } finally {
        fs.rmdirSync(lockDir);
    }
}

// ── Garbage collection ─────────────────────────────────────────────

export function collectReferencedHashes(dir: string): Set<string> {
    const hashes = new Set<string>();
    for (const jsonFile of listSpecJsonFiles(dir)) {
        const records = readSpecRecords(path.join(dir, jsonFile));
        for (const test of records?.tests ?? []) {
            for (const step of test.steps) {
                if (!isGapStep(step)) hashes.add(step.image);
            }
        }
    }
    return hashes;
}

/**
 * Delete pool files (hash-named images and HTML snapshots) that no spec JSON
 * in `dir` references. Only files matching the pool naming pattern are ever
 * touched; everything else (Playwright's per-test directories, .last-run.json,
 * the spec JSONs themselves) is left alone.
 */
export function gcPoolFiles(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    const referenced = collectReferencedHashes(dir);
    let removed = 0;
    for (const file of fs.readdirSync(dir)) {
        const match = POOL_FILE_RE.exec(file);
        if (!match || referenced.has(match[1])) continue;
        try {
            fs.rmSync(path.join(dir, file), { force: true });
            removed++;
        } catch { }
    }
    return removed;
}

// ── 1.x layout detection ───────────────────────────────────────────

/**
 * The 1.x layout kept one directory per test; 2.x directories are flat. Any
 * subdirectory in the accepted dir therefore marks a baseline this version
 * cannot read.
 */
export function hasLegacyAcceptedLayout(dir: string): boolean {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory());
}

export function legacyAcceptedHint(dir: string): string {
    return `${dir} contains subdirectories, which looks like the ShoTest 1.x per-test layout. ` +
        `ShoTest 2.x stores baselines as flat content-hashed images plus one JSON per spec file and cannot read the old layout. ` +
        `Delete the directory (e.g. "rm -rf ${dir}"), rerun your tests, and re-accept the baselines.`;
}
