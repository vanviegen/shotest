/**
 * ShoTest Review Server
 *
 * A simple Node.js HTTP server that serves a review UI for comparing
 * test screenshots against accepted baselines.
 *
 * Both test-results/ and test-accepted/ hold flat, content-hashed image pools
 * plus one JSON per test describing its steps and the images they
 * reference (see manifest.ts). Steps are compared purely by hash — equal hash
 * means pixel-identical by construction; anything else is a change. Runs are
 * expected to come from a pinned rendering environment (see entriesEquivalent
 * and the README's "Deterministic screenshots" section).
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { compressImages, conversionProgress } from './webp.js';
import {
    addPassedTest,
    findTestRecord,
    gcPoolFiles,
    hasLegacyAcceptedLayout,
    isGapStep,
    isOutdatedTestJson,
    legacyAcceptedHint,
    listTestJsonFiles,
    loadTestRecords,
    readComments,
    removeTestRecord,
    sameVisuals,
    testName,
    writeComments,
    writeTestRecord,
    type ImageStepRecord,
    type ReviewComment,
    type StepEventRecord,
    type StepRecord,
    type TestIdentity,
    type TestRecord,
} from './manifest.js';

// ── Configuration ──────────────────────────────────────────────────

const outputDir = process.env.SHOTEST_OUTPUT_DIR || 'test-results';
const acceptedDir = process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted';
const defaultPreferredPort = Number.parseInt(process.env.SHOTEST_PORT || '3847', 10);
const maxPortAttempts = 10;
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const reviewUiPath = path.join(thisDir, '..', 'build.frontend', 'index.html');

export interface StartReviewServerOptions {
    port?: number;
    openBrowser?: boolean;
}

// ── Screenshot files ───────────────────────────────────────────────

// Tests write PNGs (that is what Playwright hands us), which are recompressed
// to lossless WebP on their way to the baseline (see webp.ts). Both are read
// back. A hash exists in both formats only while a conversion is still
// working on it, and there the PNG is the copy to trust: the WebP is written
// first and the PNG only removed once it is on disk, so a PNG that is still
// around either predates its WebP or outlived a conversion.
const imageExtensions = ['.png', '.webp'];

function findScreenshotFile(dir: string, hash: string): string | undefined {
    return imageExtensions.map((ext) => hash + ext).find((file) => fs.existsSync(path.join(dir, file)));
}

// ── Test identity ──────────────────────────────────────────────────

// Tests are identified by (spec file, title). The API and routes carry that
// pair as one opaque, URL-safe token.
export function testId(record: Pick<TestRecord, 'file' | 'title'>): string {
    return Buffer.from(JSON.stringify([record.file, record.title]), 'utf-8').toString('base64url');
}

function decodeTestId(id: string): TestIdentity | null {
    try {
        const decoded = JSON.parse(Buffer.from(id, 'base64url').toString('utf-8'));
        if (Array.isArray(decoded) && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
            return { file: decoded[0], title: decoded[1] };
        }
    } catch { }
    return null;
}

// ── Step alignment ─────────────────────────────────────────────────

type AlignEntry =
    | { kind: 'image'; step: ImageStepRecord }
    | { kind: 'gap'; text: string };

function buildAlignEntries(steps: StepRecord[]): AlignEntry[] {
    return steps.map((step) => isGapStep(step)
        ? { kind: 'gap' as const, text: step.gap }
        : { kind: 'image' as const, step });
}

// Whether a step looks the same on both sides, as sameVisuals compares them:
// purely visual, events never enter into it. Differing event lists are a
// display concern (the review app offers an accepted/current flip on such
// steps), not a change to review.
function entriesEquivalent(accepted: AlignEntry, current: AlignEntry): boolean {
    if (accepted.kind === 'gap' || current.kind === 'gap') {
        return accepted.kind === 'gap' && current.kind === 'gap' && accepted.text === current.text;
    }
    return accepted.step.image === current.step.image;
}

interface AlignedPair {
    // Exactly one of these two shapes is populated:
    // gap steps carry their (possibly differing) texts per side,
    acceptedGap?: string;
    currentGap?: string;
    // image steps carry the image hash and event list per side.
    acceptedImage?: string;
    currentImage?: string;
    acceptedEvents?: StepEventRecord[];
    currentEvents?: StepEventRecord[];
    viewport?: { width: number; height: number };
    role?: string;
    /** Why the current capture was not taken at rest (see ImageStepRecord). */
    unstable?: string;
    changed: boolean;
}

function makeAlignedPair(
    accepted: AlignEntry | undefined,
    current: AlignEntry | undefined,
    changed: boolean,
): AlignedPair {
    const entry = current ?? accepted!;
    if (entry.kind === 'gap') {
        return {
            acceptedGap: accepted?.kind === 'gap' ? accepted.text : undefined,
            currentGap: current?.kind === 'gap' ? current.text : undefined,
            changed,
        };
    }
    const acceptedStep = accepted?.kind === 'image' ? accepted.step : undefined;
    const currentStep = current?.kind === 'image' ? current.step : undefined;
    const step = currentStep ?? acceptedStep!;
    return {
        acceptedImage: acceptedStep?.image,
        currentImage: currentStep?.image,
        acceptedEvents: acceptedStep?.events,
        currentEvents: currentStep?.events,
        viewport: step.viewport,
        role: step.role,
        unstable: currentStep?.unstable,
        changed,
    };
}

// The events that identify a step for alignment. Console output is ambient
// (its timing shifts run to run) and is left out.
function significantEvents(events: StepEventRecord[] = []): StepEventRecord[] {
    return events.filter((event) => event.type !== 'console');
}

// Whether two entries are the same *moment in the test*: image steps whose
// significant events match by message. Messages are type-prefixed by
// construction ('click "Submit"', 'goto /', 'expect text'), so comparing
// types too would only re-state them — and would break alignment across
// event-type renames (2.0 baselines say 'goto' where newer runs say 'page').
// Sources (line numbers shift on every edit), durations and boxes carry no
// identity. Empty event lists don't count — a vacuous match could steal
// alignment from the plain index pairing that handles such steps fine.
function sameTestMoment(accepted: AlignEntry, current: AlignEntry): boolean {
    if (accepted.kind !== 'image' || current.kind !== 'image') return false;
    const a = significantEvents(accepted.step.events);
    const c = significantEvents(current.step.events);
    return a.length > 0 && a.length === c.length &&
        a.every((event, i) => event.message === c[i].message);
}

/**
 * Walk a longest-common-subsequence (by `eq`) over the two sequences,
 * calling `emitMatch` for every matched pair and `emitWindow` for every
 * (non-empty) run of unmatched entries between and around the matches — all
 * in sequence order.
 */
function lcsWalk(
    accepted: AlignEntry[],
    current: AlignEntry[],
    eq: (accepted: AlignEntry, current: AlignEntry) => boolean,
    emitMatch: (accepted: AlignEntry, current: AlignEntry) => void,
    emitWindow: (accepted: AlignEntry[], current: AlignEntry[]) => void,
): void {
    // lcs[i][j] = length of the LCS of accepted[i..] and current[j..].
    const lcs: number[][] = Array.from({ length: accepted.length + 1 },
        () => new Array<number>(current.length + 1).fill(0));
    for (let i = accepted.length - 1; i >= 0; i--) {
        for (let j = current.length - 1; j >= 0; j--) {
            lcs[i][j] = eq(accepted[i], current[j])
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    const pendingAccepted: AlignEntry[] = [];
    const pendingCurrent: AlignEntry[] = [];
    const flush = () => {
        if (pendingAccepted.length > 0 || pendingCurrent.length > 0) {
            emitWindow(pendingAccepted.splice(0), pendingCurrent.splice(0));
        }
    };

    let i = 0;
    let j = 0;
    while (i < accepted.length && j < current.length) {
        if (eq(accepted[i], current[j])) {
            flush();
            emitMatch(accepted[i++], current[j++]);
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            pendingAccepted.push(accepted[i++]);
        } else {
            pendingCurrent.push(current[j++]);
        }
    }
    pendingAccepted.push(...accepted.slice(i));
    pendingCurrent.push(...current.slice(j));
    flush();
}

// Align the two step sequences in three tiers, each running only inside the
// windows the tier above could not match:
//
//   1. Pixel-identical (or gap-text-equal) steps — certainty; these pair up
//      unchanged, and are never sacrificed for a lower-tier match.
//   2. Same test moment (see sameTestMoment) — a step whose look changed but
//      whose actions and checks are the very same. This is what keeps a
//      global restyle (every hash different) aligned around an inserted or
//      removed step, instead of index-smearing everything after it.
//   3. Index pairing for whatever identity can't reach, except that a gap
//      never pairs with an image (the gap is emitted on its own, so pair
//      slots stay image-vs-image — which is what the compare view can show).
//
// Events influence only the *pairing*, never the verdict: every pair emitted
// from inside a window — tier 2 and 3 alike — is changed or one-sided, and a
// window emits at least one such pair under any pairing. The verdict stays
// purely visual.
function alignSteps(accepted: AlignEntry[], current: AlignEntry[]): AlignedPair[] {
    const result: AlignedPair[] = [];

    const pairByIndex = (windowAccepted: AlignEntry[], windowCurrent: AlignEntry[]) => {
        let a = 0;
        let c = 0;
        while (a < windowAccepted.length && c < windowCurrent.length) {
            const acceptedEntry = windowAccepted[a];
            const currentEntry = windowCurrent[c];
            if (acceptedEntry.kind !== currentEntry.kind) {
                if (acceptedEntry.kind === 'gap') {
                    result.push(makeAlignedPair(acceptedEntry, undefined, true));
                    a++;
                } else {
                    result.push(makeAlignedPair(undefined, currentEntry, true));
                    c++;
                }
                continue;
            }
            result.push(makeAlignedPair(acceptedEntry, currentEntry, true));
            a++;
            c++;
        }
        for (; a < windowAccepted.length; a++) result.push(makeAlignedPair(windowAccepted[a], undefined, true));
        for (; c < windowCurrent.length; c++) result.push(makeAlignedPair(undefined, windowCurrent[c], true));
    };

    const pairBySameEvents = (windowAccepted: AlignEntry[], windowCurrent: AlignEntry[]) =>
        lcsWalk(windowAccepted, windowCurrent, sameTestMoment,
            (a, c) => result.push(makeAlignedPair(a, c, true)), pairByIndex);

    lcsWalk(accepted, current, entriesEquivalent,
        (a, c) => result.push(makeAlignedPair(a, c, false)), pairBySameEvents);
    return result;
}

// What became of a step: the review app's getStepChange() decides the same.
// A side counts as present when its field is *there*, not when it is truthy:
// a gap step whose text is empty (suppressScreenshots('')) is still a step.
type StepChange = 'changed' | 'unchanged' | 'removed' | 'new';

function stepChange(step: AlignedPair): StepChange {
    if (step.acceptedImage === undefined && step.acceptedGap === undefined) return 'new';
    if (step.currentImage === undefined && step.currentGap === undefined) return 'removed';
    return step.changed ? 'changed' : 'unchanged';
}

// ── The review session ─────────────────────────────────────────────

// What the reviewer decided so far: nothing touches test-accepted/ until the
// review is applied. Kept next to the results it is about, so a restarted
// server picks it up, and a new test run (which starts test-results/ afresh)
// drops it.
interface ReviewSession {
    /** Ids of the tests marked accepted. */
    accepted: string[];
    /** The comments of every test whose comments were edited, by test id. */
    comments: Record<string, ReviewComment[]>;
}

const sessionPath = path.join(outputDir, '.review-session.json');

function loadSession(): ReviewSession {
    try {
        return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
        return { accepted: [], comments: {} };
    }
}

let session = loadSession();

function saveSession(): void {
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf-8');
}

function isAccepted(id: string): boolean {
    return session.accepted.includes(id);
}

function commentsOf(test: TestIdentity): ReviewComment[] {
    return session.comments[testId(test)] ?? readComments(acceptedDir, test);
}

// ── Test listing and details ───────────────────────────────────────

interface TestSummary {
    id: string;
    file: string;
    line: number;
    title: string;
    status: string;
    hasChanges: boolean;
    orphaned: boolean;
    accepted: boolean;
    comments: number;
}

// Stands in for the source file of an orphaned baseline (whose spec may no
// longer exist), grouping them together at the bottom of the review app's list.
const orphanedGroupLabel = 'not in test-results/';

function getTests(): TestSummary[] {
    const currentTests = loadTestRecords(outputDir);
    const acceptedTests = loadTestRecords(acceptedDir);
    const acceptedByKey = new Map(acceptedTests.map((test) => [testId(test), test]));
    const summary = (record: TestRecord, hasChanges: boolean, orphaned: boolean) => ({
        id: testId(record),
        file: orphaned ? orphanedGroupLabel : record.file,
        line: orphaned ? 0 : record.line ?? 0,
        title: orphaned ? testName(record) : record.title,
        status: orphaned ? 'orphaned' : record.status ?? 'unknown',
        hasChanges,
        orphaned,
        accepted: isAccepted(testId(record)),
        comments: commentsOf(record).length,
    });

    const tests = currentTests.map((record) =>
        summary(record, !sameVisuals(acceptedByKey.get(testId(record))?.steps ?? [], record.steps), false));

    // Baselines without a matching test in test-results: the test was renamed
    // or deleted — or it simply wasn't part of this run. Listing them (last) is
    // what makes them deletable from the review app; nothing else ever cleans
    // them up, so otherwise they linger in version control forever.
    const currentKeys = new Set(currentTests.map((test) => testId(test)));
    for (const record of acceptedTests) {
        if (currentKeys.has(testId(record)) || record.steps.length === 0) continue;
        tests.push(summary(record, true, true));
    }

    return tests.sort((a, b) =>
        Number(a.orphaned) - Number(b.orphaned) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.title.localeCompare(b.title)
    );
}

function significantMessages(events: StepEventRecord[] = []): string[] {
    return significantEvents(events).map((event) => event.message);
}

// Where a comment goes in this run: the step showing the very screenshot it
// was made on, or else the step at the same moment in the test (its look
// changed); none when the test no longer has either.
function commentStep(comment: ReviewComment, steps: AlignedPair[]): number | undefined {
    let index = steps.findIndex((step) => step.currentImage === comment.image || step.acceptedImage === comment.image);
    if (index < 0 && comment.events.length > 0) {
        const key = JSON.stringify(comment.events);
        index = steps.findIndex((step) => step.currentImage !== undefined
            && JSON.stringify(significantMessages(step.currentEvents)) === key);
    }
    return index < 0 ? undefined : index;
}

function getTestDetails(test: TestIdentity): {
    manifest: TestRecord | null;
    steps: AlignedPair[];
    orphaned: boolean;
    accepted: boolean;
    comments: Array<{ text: string; step?: number }>;
} {
    const currentRecord = findTestRecord(outputDir, test);
    const acceptedRecord = findTestRecord(acceptedDir, test);
    // With no test run under this identity, a baseline still there aligns
    // against nothing: every step comes out as removed, so the review app
    // can show what the stale baseline holds before it is dropped.
    const steps = alignSteps(buildAlignEntries(acceptedRecord?.steps ?? []), buildAlignEntries(currentRecord?.steps ?? []));
    return {
        manifest: currentRecord ?? null,
        steps,
        orphaned: !currentRecord && !!acceptedRecord,
        accepted: isAccepted(testId(test)),
        comments: commentsOf(test).map((comment) => ({ text: comment.text, step: commentStep(comment, steps) })),
    };
}

// ── Deciding ───────────────────────────────────────────────────────

// The images of a test's run that the accepted pool does not have yet.
function newImages(record: TestRecord | undefined): string[] {
    return (record?.steps ?? []).flatMap((step) =>
        !isGapStep(step) && !findScreenshotFile(acceptedDir, step.image) ? [step.image] : []);
}

function setAccepted(test: TestIdentity, accepted: boolean): void {
    const id = testId(test);
    session.accepted = session.accepted.filter((other) => other !== id);
    if (accepted) {
        session.accepted.push(id);
        // Convert ahead of time, so applying has little left to wait for.
        void compressImages(outputDir, newImages(findTestRecord(outputDir, test)));
    }
    saveSession();
}

function addComment(test: TestIdentity, stepIndex: number, text: string): void {
    const step = getTestDetails(test).steps[stepIndex];
    const image = step?.currentImage ?? step?.acceptedImage;
    if (!image) throw new Error('No screenshot to comment on');
    const events = significantMessages(step.currentImage !== undefined ? step.currentEvents : step.acceptedEvents);
    session.comments[testId(test)] = [...commentsOf(test), { text, image, events }];
    saveSession();
}

function removeComment(test: TestIdentity, index: number): void {
    session.comments[testId(test)] = commentsOf(test).filter((_, i) => i !== index);
    saveSession();
}

// ── Applying ───────────────────────────────────────────────────────

// The baseline keeps the steps verbatim — events included, with their source
// lines, durations and console output, so the review app can show the
// accepted side of a step exactly as it once ran. Only test-level run
// metadata (status, error, timing) is dropped: a baseline records what was
// approved, not how the approving run went. Nothing kept here can flag a
// later run as changed — comparison never reads events (sameVisuals).
function stripForAccept(record: TestRecord): TestRecord {
    return { file: record.file, title: record.title, steps: record.steps };
}

async function applyReview(): Promise<void> {
    const accepted = session.accepted.flatMap((id) => {
        const test = decodeTestId(id);
        return test ? [{ test, record: findTestRecord(outputDir, test) }] : [];
    });
    await compressImages(outputDir, accepted.flatMap(({ record }) => newImages(record)));

    for (const { test, record } of accepted) {
        writeComments(acceptedDir, test, []);

        // The test produced no record (orphaned baseline) or no screenshots at
        // all: accepting that state means dropping the baseline it left behind.
        if (!record || record.steps.length === 0) {
            removeTestRecord(acceptedDir, test);
            continue;
        }

        // Copy images into the pool first, JSON second: a reader following the
        // JSON must find every file it references.
        fs.mkdirSync(acceptedDir, { recursive: true });
        for (const hash of newImages(record)) {
            const sourceFile = findScreenshotFile(outputDir, hash);
            if (!sourceFile) {
                console.warn(`ShoTest: missing ${hash} in ${outputDir}, baseline will be incomplete`);
                continue;
            }
            fs.copyFileSync(path.join(outputDir, sourceFile), path.join(acceptedDir, sourceFile));
        }
        writeTestRecord(acceptedDir, stripForAccept(record));
        // The test now passes against its baseline on the tree it ran on.
        if (record.status === 'passed' && record.tree) addPassedTest(acceptedDir, record.tree, record);
    }

    for (const [id, comments] of Object.entries(session.comments)) {
        const test = decodeTestId(id);
        if (test && !isAccepted(id)) writeComments(acceptedDir, test, comments);
    }

    // A replaced baseline may have been the last reference to some pool images.
    gcPoolFiles(acceptedDir);
    endSession();
}

function endSession(): void {
    fs.rmSync(sessionPath, { force: true });
    session = { accepted: [], comments: {} };
}

// ── The report ─────────────────────────────────────────────────────

/**
 * Print what is left for whoever runs `shotest review` (an AI agent, say):
 * every test whose visual changes were not accepted, or that has comments,
 * with the comments and the steps they concern. Returns the exit code: 0
 * when nothing is left, 1 otherwise.
 */
export function printReviewReport(): number {
    const tests = getTests().filter((test) => (test.hasChanges && !test.accepted) || test.comments > 0);
    if (tests.length === 0) {
        console.log('\nShoTest review: all visual changes are accepted, and no comments are open.');
        return 0;
    }

    const imagePath = (dir: string, hash: string | undefined) => {
        const file = hash && findScreenshotFile(dir, hash);
        return file ? path.join(dir, file) : undefined;
    };

    console.log(`\nShoTest review: ${tests.length} test(s) not accepted:`);
    for (const test of tests) {
        const identity = decodeTestId(test.id)!;
        const detail = getTestDetails(identity);
        const counts = (['changed', 'new', 'removed'] as const)
            .map((change) => [change, detail.steps.filter((step) => stepChange(step) === change).length] as const)
            .filter(([, count]) => count > 0)
            .map(([change, count]) => `${count} ${change}`);
        const status = testIsFailed(test.status) ? [test.status] : [];
        console.log(`\n- ${testName(identity)}${[...status, ...counts].length ? ` (${[...status, ...counts].join(', ')} step(s))` : ''}`);
        for (const comment of detail.comments) {
            const step = comment.step === undefined ? undefined : detail.steps[comment.step];
            if (!step) {
                console.log(`  - On a screenshot this run no longer has: ${comment.text}`);
                continue;
            }
            const event = significantEvents(step.currentEvents ?? step.acceptedEvents)[0];
            const where = event ? ` (${event.message}${event.source ? ` at ${event.source}` : ''})` : '';
            console.log(`  - On step ${comment.step! + 1}${where}: ${comment.text}`);
            const current = imagePath(outputDir, step.currentImage);
            const accepted = imagePath(acceptedDir, step.acceptedImage);
            if (current) console.log(`    current screenshot: ${current}`);
            if (accepted && step.acceptedImage !== step.currentImage) console.log(`    accepted screenshot: ${accepted}`);
        }
    }
    return 1;
}

function testIsFailed(status: string): boolean {
    return status === 'failed' || status === 'timedOut';
}

// ── HTTP Server ────────────────────────────────────────────────────

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
    try {
        const data = fs.readFileSync(filePath);
        // While pool images are content-addressed, a hash URL's *format*
        // (png/webp) can still swap. A cached copy would leave the reviewer
        // toggling between two renderings of the same image, which reads as
        // "nothing changed" — the one conclusion this app must never invent.
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

function readTestId(res: http.ServerResponse, encoded: string): TestIdentity | null {
    const decoded = decodeTestId(decodeURIComponent(encoded));
    if (decoded) return decoded;

    res.writeHead(400);
    res.end('Invalid test id');
    return null;
}

function serveJson(res: http.ServerResponse, data: any) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function resolveReviewDirectory(dirPath: string): string {
    return path.resolve(process.cwd(), dirPath);
}

function announceServer(port: number, openBrowser: boolean) {
    const url = `http://localhost:${port}`;
    console.log(`- uri: ${url}\n`);

    if (!openBrowser) {
        return;
    }

    // Try to open browser; inside a TPS task, ask TPS to show the user the page.
    try {
        const platform = process.platform;
        if (fs.existsSync('/tps/guest-tool')) execSync(`/tps/guest-tool request-human-views ${port}`, { stdio: 'ignore' });
        else if (platform === 'linux') execSync(`xdg-open ${url}`, { stdio: 'ignore' });
        else if (platform === 'darwin') execSync(`open ${url}`, { stdio: 'ignore' });
        else if (platform === 'win32') execSync(`start ${url}`, { stdio: 'ignore' });
    } catch { }
}

/**
 * Serve the review app until the reviewer applies or discards the review,
 * then print what is left (see printReviewReport) and exit with its code — so
 * a script, or an AI agent, waits for the reviewer's verdict by waiting for
 * `shotest review` to end. With nothing to review, it ends right away.
 */
export function startReviewServer(options: StartReviewServerOptions = {}): Promise<http.Server> {
    const preferredPort = options.port ?? defaultPreferredPort;
    const openBrowser = options.openBrowser ?? true;
    const resolvedOutputDir = resolveReviewDirectory(outputDir);
    const resolvedAcceptedDir = resolveReviewDirectory(acceptedDir);

    console.log('ShoTest review');
    console.log(`- output-dir: ${resolvedOutputDir}`);
    console.log(`- accepted-dir: ${resolvedAcceptedDir}`);

    if (!fs.existsSync(resolvedOutputDir) || !fs.statSync(resolvedOutputDir).isDirectory()) {
        throw new Error(`ShoTest Review: output-dir does not exist`);
    }

    if (hasLegacyAcceptedLayout(resolvedAcceptedDir)) {
        throw new Error('ShoTest Review: ' + legacyAcceptedHint(acceptedDir));
    }

    // Test JSONs from an older format version are ignored, so their tests
    // read as never-accepted (all steps "new") — accepting rebuilds them in
    // the current format. Say so, or the silent downgrade looks like a bug.
    const outdatedBaselines = listTestJsonFiles(resolvedAcceptedDir)
        .filter((file) => isOutdatedTestJson(path.join(resolvedAcceptedDir, file)));
    if (outdatedBaselines.length > 0) {
        console.warn(`ShoTest Review: ignoring ${outdatedBaselines.length} baseline JSON(s) in ${acceptedDir} written by an older ShoTest version (${outdatedBaselines.join(', ')}). Their tests show as new; accepting them records a fresh baseline.`);
    }

    if (listTestJsonFiles(resolvedOutputDir).length === 0 &&
        fs.readdirSync(resolvedOutputDir, { withFileTypes: true })
            .some((entry) => entry.isDirectory() && fs.existsSync(path.join(resolvedOutputDir, entry.name, 'manifest.json')))) {
        console.warn('ShoTest Review: test-results looks like output from ShoTest 1.x — rerun your tests to produce current results.');
    }

    // Nothing to review at all: don't bother binding a port or opening a
    // browser on an empty worklist.
    if (!getTests().some((test) => test.hasChanges || test.comments > 0)) {
        process.exit(printReviewReport());
    }

    let currentPort = preferredPort;

    // Applying or discarding ends the review: once the answer is on the wire
    // (exiting first would drop it), report and exit.
    const endReview = (res: http.ServerResponse, outcome: string) => {
        serveJson(res, { ok: true });
        res.on('finish', () => {
            console.log(`\nShoTest review: ${outcome}.`);
            process.exit(printReviewReport());
        });
    };

    const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url || '/', `http://localhost:${currentPort}`);
        const pathname = url.pathname;

        try {
            if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/image/')) {
                serveFile(res, reviewUiPath, 'text/html; charset=utf-8');
                return;
            }

            // The review app polls this to notice the server going away (it
            // then says so in a dialog, rather than silently showing a page
            // whose buttons no longer do anything). Deliberately cheaper than
            // /api/tests, which re-reads every baseline.
            if (pathname === '/api/ping') {
                serveJson(res, { ok: true });
                return;
            }

            if (pathname === '/api/tests') {
                serveJson(res, getTests());
                return;
            }

            const testDetailMatch = pathname.match(/^\/api\/test\/([^/]+)$/);
            if (testDetailMatch && req.method === 'GET') {
                const id = readTestId(res, testDetailMatch[1]);
                if (!id) return;
                serveJson(res, getTestDetails(id));
                return;
            }

            const acceptMatch = pathname.match(/^\/api\/accepted\/([^/]+)$/);
            if (acceptMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
                const id = readTestId(res, acceptMatch[1]);
                if (!id) return;
                setAccepted(id, req.method === 'PUT');
                serveJson(res, { ok: true });
                return;
            }

            const commentsMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
            if (commentsMatch && req.method === 'POST') {
                const id = readTestId(res, commentsMatch[1]);
                if (!id) return;
                const { step, text } = await readJsonBody(req);
                addComment(id, step, text);
                serveJson(res, { ok: true });
                return;
            }

            const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)\/(\d+)$/);
            if (commentMatch && req.method === 'DELETE') {
                const id = readTestId(res, commentMatch[1]);
                if (!id) return;
                removeComment(id, Number(commentMatch[2]));
                serveJson(res, { ok: true });
                return;
            }

            if (pathname === '/api/progress') {
                serveJson(res, conversionProgress);
                return;
            }

            if (pathname === '/api/apply' && req.method === 'POST') {
                await applyReview();
                endReview(res, 'applied');
                return;
            }

            if (pathname === '/api/discard' && req.method === 'POST') {
                endSession();
                endReview(res, 'discarded, nothing changed');
                return;
            }

            // Images are addressed by bare hash; the server resolves whichever
            // format (png/webp) the pool holds at this moment. The current
            // side of a test that was skipped as unchanged is its baseline's.
            const imageMatch = pathname.match(/^\/image\/(current|accepted)\/([0-9a-f]{16})$/);
            if (imageMatch) {
                const dirs = imageMatch[1] === 'current' ? [outputDir, acceptedDir] : [acceptedDir];
                const dir = dirs.find((candidate) => findScreenshotFile(candidate, imageMatch[2]));
                if (!dir) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                const file = findScreenshotFile(dir, imageMatch[2])!;
                const contentType = file.endsWith('.webp') ? 'image/webp' : 'image/png';
                serveFile(res, path.join(dir, file), contentType);
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
    });

    return new Promise((resolve, reject) => {
        function onListening() {
            server.off('error', onError);
            announceServer(currentPort, openBrowser);
            resolve(server);
        }

        function onError(error: NodeJS.ErrnoException) {
            if (error.code !== 'EADDRINUSE') {
                server.off('listening', onListening);
                reject(error);
                return;
            }

            const nextPort = currentPort + 1;
            if (nextPort >= preferredPort + maxPortAttempts) {
                server.off('listening', onListening);
                reject(new Error(`ShoTest Review: could not bind to a port between ${preferredPort} and ${preferredPort + maxPortAttempts - 1}`));
                return;
            }

            currentPort = nextPort;
            server.listen(currentPort);
        }

        server.on('error', onError);
        server.once('listening', onListening);
        server.listen(currentPort);
    });
}
