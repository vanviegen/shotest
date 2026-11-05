/**
 * The ShoTest on-disk data model, shared by the fixture (writer), the
 * review server, and the CLI (gc).
 *
 * Both test-results/ and test-accepted/ are flat:
 *   <test-base>.json           one file per test, listing its steps
 *   <hash>.png|.webp           screenshots, named by pixel-content hash (see hash.ts)
 *   <hash>.body.html           DOM snapshots (test-results only, when enabled)
 * test-accepted/ also holds:
 *   <test-base>.comments.json  review comments on a test not accepted yet
 *   <tree-hash>.passed         the tests that passed against their baseline
 *                              at that source tree (see sourceTreeHash)
 *
 * One file per test (rather than per spec file) keeps branches that accept
 * different tests from conflicting when they are merged.
 *
 * Screenshots are clean captures of the page; what happened at each moment
 * (clicks, assertions, navigations) is recorded as *events* on the step, with
 * the viewport box of the element involved. Steps reference images by hash,
 * so multiple tests and steps can share one pool file; `shotest gc` removes
 * pool files no JSON references anymore.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { POOL_FILE_RE } from './hash.js';

/**
 * The test JSON format version. Bumped whenever the record shape changes in a
 * way older readers (or this reader, for older files) cannot handle; files
 * carrying another version — including the versionless pre-event format —
 * are ignored, so their tests read as "no data yet". Version 3 baselines
 * (one JSON per spec file) are split up by migrateAcceptedDir.
 */
export const RECORD_VERSION = 4;

/**
 * Something that happened while the page looked like the step's screenshot.
 *
 * Events are display data only: whether a test changed is decided purely from
 * its screenshots (and gap texts) — see entriesEquivalent in review.ts. If
 * the pictures match and the test is green, all is well, no matter how it
 * got there; an unchanged step shows the current run's events alone. The
 * baseline's events serve to pair up steps whose look changed, and to say
 * what happened on a changed or removed step's accepted side.
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
    /**
     * Set when the frame could not be captured at rest: why the page never
     * settled (what was last seen moving), or that a detectUnstable second
     * capture differed. Such a capture fails the test unless screenshots were
     * suppressed there (a forced screenshot, an error capture), so this is
     * mostly seen on those — the review app flags the step with it.
     */
    unstable?: string;
}

/** A placeholder for steps that ran without screenshots (suppressScreenshots). */
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
    /** The source tree the test ran on (see sourceTreeHash). Results only. */
    tree?: string;
    /**
     * Results only: the test did not run, as it already passed on this very
     * source tree; its steps are the baseline's, whose images stay in the
     * accepted pool.
     */
    cached?: boolean;
}

export type TestIdentity = Pick<TestRecord, 'file' | 'title'>;

/** How a test is named to people: in stamps and in the review's report. */
export function testName(test: TestIdentity): string {
    return `${test.file} › ${test.title}`;
}

// ── Test JSON files ────────────────────────────────────────────────

/**
 * The file name stem for a test: readable, and unique through a hash of the
 * full identity — "my.spec.ts", "Login works" → "my-spec-login-works-1a2b3c4d".
 */
export function testFileBase(test: TestIdentity): string {
    const slug = (path.basename(test.file).replace(/\.[cm]?[jt]sx?$/, '') + ' ' + test.title)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
    const hash = createHash('sha256').update(test.file + '\0' + test.title).digest('hex').slice(0, 8);
    return `${slug}-${hash}`;
}

const COMMENTS_SUFFIX = '.comments.json';

export function listTestJsonFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((file) => file.endsWith('.json') && !file.endsWith(COMMENTS_SUFFIX) && !file.startsWith('.'))
        .sort();
}

/**
 * Read a test JSON, or null when it is unreadable *or from another format
 * version*. Old-format files thus act as if their tests never existed —
 * accepting a test writes a fresh file, and gc drops the images only the old
 * file referenced.
 */
export function readTestRecord(jsonPath: string): TestRecord | null {
    try {
        const { version, ...record } = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        if (version === RECORD_VERSION && typeof record.title === 'string' && Array.isArray(record.steps)) return record as TestRecord;
    } catch { }
    return null;
}

/** Whether a test JSON exists but was ignored by readTestRecord (old format). */
export function isOutdatedTestJson(jsonPath: string): boolean {
    return fs.existsSync(jsonPath) && readTestRecord(jsonPath) === null;
}

export function loadTestRecords(dir: string): TestRecord[] {
    return listTestJsonFiles(dir).flatMap((file) => readTestRecord(path.join(dir, file)) ?? []);
}

export function findTestRecord(dir: string, test: TestIdentity): TestRecord | undefined {
    return readTestRecord(path.join(dir, testFileBase(test) + '.json')) ?? undefined;
}

// Atomic replace, so a concurrent reader never sees a torn file.
function writeFileAtomic(filePath: string, text: string): void {
    const tmpPath = filePath + '.tmp' + process.pid;
    fs.writeFileSync(tmpPath, text, 'utf-8');
    fs.renameSync(tmpPath, filePath);
}

function writeJson(jsonPath: string, data: unknown): void {
    writeFileAtomic(jsonPath, JSON.stringify(data, null, 2) + '\n');
}

export function writeTestRecord(dir: string, record: TestRecord): void {
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, testFileBase(record) + '.json'), { version: RECORD_VERSION, ...record });
}

export function removeTestRecord(dir: string, test: TestIdentity): void {
    fs.rmSync(path.join(dir, testFileBase(test) + '.json'), { force: true });
}

/**
 * Whether two step lists look the same: equal images (pixel-identical, as
 * they are named by a hash of their pixels) and gap texts, in the same order.
 * Events never enter into it — if the pictures match and the test is green,
 * all is well no matter which checks got it there.
 *
 * "Same screenshot" means pixel-identical, with no tolerance: screenshots are
 * deterministic within one rendering environment (pinned browser build,
 * software rasterization, animations disabled, fonts awaited); keeping that
 * environment pinned across machines is what the containerized `shotest
 * test` is for (see the README's "Deterministic screenshots" section).
 */
export function sameVisuals(a: StepRecord[], b: StepRecord[]): boolean {
    const key = (step: StepRecord) => isGapStep(step) ? 'gap:' + step.gap : step.image;
    return a.length === b.length && a.every((step, i) => key(step) === key(b[i]));
}

/**
 * Split version 3 baselines — one JSON per spec file, listing its tests — into
 * one file per test. Leaves anything else alone.
 */
export function migrateAcceptedDir(dir: string): void {
    for (const file of listTestJsonFiles(dir)) {
        const jsonPath = path.join(dir, file);
        let data: any;
        try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch { continue; }
        if (data?.version !== 3 || !Array.isArray(data.tests)) continue;
        for (const record of data.tests) writeTestRecord(dir, record);
        fs.rmSync(jsonPath);
    }
}

// ── Review comments ────────────────────────────────────────────────

/**
 * A reviewer's remark on a screenshot of a test that was not accepted. It
 * outlives the run it was made on: a later run reattaches it to the step with
 * the same image, or else to the step with the same significant events (the
 * same moment in the test, its look changed).
 */
export interface ReviewComment {
    text: string;
    /** The screenshot commented on. */
    image: string;
    /** That step's significant (non-console) event messages. */
    events: string[];
}

interface CommentsFile extends TestIdentity {
    comments: ReviewComment[];
}

function commentsPath(dir: string, test: TestIdentity): string {
    return path.join(dir, testFileBase(test) + COMMENTS_SUFFIX);
}

export function readComments(dir: string, test: TestIdentity): ReviewComment[] {
    try {
        return (JSON.parse(fs.readFileSync(commentsPath(dir, test), 'utf-8')) as CommentsFile).comments ?? [];
    } catch {
        return [];
    }
}

/** Store a test's comments; none at all removes the file. */
export function writeComments(dir: string, test: TestIdentity, comments: ReviewComment[]): void {
    if (comments.length === 0) {
        fs.rmSync(commentsPath(dir, test), { force: true });
        return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const data: CommentsFile = { file: test.file, title: test.title, comments };
    writeJson(commentsPath(dir, test), data);
}

// ── Pass stamps ────────────────────────────────────────────────────

/**
 * Stamps record which tests passed, looking exactly like their baseline, on
 * a source tree: `<tree-hash>.passed` lists their names, one per line. A
 * test listed for the tree a run is on can be skipped — nothing it depends
 * on changed. Only the current tree's stamp is ever useful, so writing one
 * deletes the others. Naming the file after the tree means two branches
 * never write the same file, so merging them does not conflict.
 */
const STAMP_SUFFIX = '.passed';

function stampPath(dir: string, tree: string): string {
    return path.join(dir, tree + STAMP_SUFFIX);
}

export function readPassedTests(dir: string, tree: string): Set<string> {
    try {
        return new Set(fs.readFileSync(stampPath(dir, tree), 'utf-8').split('\n').filter(Boolean));
    } catch {
        return new Set();
    }
}

/** Add a test to the stamp of `tree`. Safe across Playwright worker processes. */
export function addPassedTest(dir: string, tree: string, test: TestIdentity): void {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = stampPath(dir, tree);
    withFileLock(stamp, () => {
        const names = readPassedTests(dir, tree);
        names.add(testName(test));
        writeFileAtomic(stamp, [...names].sort().join('\n') + '\n');
        for (const file of fs.readdirSync(dir)) {
            if (file.endsWith(STAMP_SUFFIX) && file !== tree + STAMP_SUFFIX) fs.rmSync(path.join(dir, file), { force: true });
        }
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
    for (const test of loadTestRecords(dir)) {
        for (const step of test.steps) {
            if (!isGapStep(step)) hashes.add(step.image);
        }
    }
    return hashes;
}

/**
 * Delete pool files (hash-named images and HTML snapshots) that no test JSON
 * in `dir` references. Only files matching the pool naming pattern are ever
 * touched; everything else (Playwright's per-test directories, .last-run.json,
 * the test JSONs, comments and stamps) is left alone.
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
        `ShoTest 2.x and later store baselines as flat content-hashed images plus JSON files and cannot read the old layout. ` +
        `Delete the directory (e.g. "rm -rf ${dir}"), rerun your tests, and re-accept the baselines.`;
}
