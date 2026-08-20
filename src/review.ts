/**
 * ShoTest Review Server
 *
 * A simple Node.js HTTP server that serves a review UI for comparing
 * test screenshots against accepted baselines.
 *
 * Both test-results/ and test-accepted/ hold flat, content-hashed image pools
 * plus one JSON per spec file describing tests, steps and the images they
 * reference (see manifest.ts). Steps are compared by hash first — equal hash
 * means pixel-identical by construction — and by odiff (which tolerates
 * insignificant differences) when the hashes differ.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { areImagesEquivalent } from './visual-compare.js';
import { compressAcceptedPool } from './webp.js';
import {
    eventsEquivalent,
    gcPoolFiles,
    hasLegacyAcceptedLayout,
    isGapStep,
    isOutdatedSpecJson,
    legacyAcceptedHint,
    listSpecJsonFiles,
    mergeTestRecord,
    readSpecRecords,
    significantEvents,
    specJsonName,
    withFileLock,
    writeSpecRecords,
    type ImageStepRecord,
    type StepEventRecord,
    type StepRecord,
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

// Tests write PNGs (that is what Playwright hands us), accepted baselines are
// recompressed to lossless WebP in the background. Both are read back. A hash
// exists in both formats only while a conversion is still working on it, and
// there the PNG is the copy to trust: the WebP is written first and the PNG only
// removed once it is on disk, so a PNG that is still around either predates its
// WebP or outlived a conversion.
const imageExtensions = ['.png', '.webp'];

function findScreenshotFile(dir: string, hash: string): string | undefined {
    return imageExtensions.map((ext) => hash + ext).find((file) => fs.existsSync(path.join(dir, file)));
}

// A background conversion may have replaced a screenshot with its other format
// between the moment a path was resolved and the moment the file is read.
function resolveExistingScreenshot(filePath: string): string {
    if (fs.existsSync(filePath) || !imageExtensions.includes(path.extname(filePath).toLowerCase())) {
        return filePath;
    }

    const dir = path.dirname(filePath);
    const alternate = findScreenshotFile(dir, path.basename(filePath, path.extname(filePath)));
    return alternate ? path.join(dir, alternate) : filePath;
}

// ── Test identity ──────────────────────────────────────────────────

// Tests are identified by (spec file, title). The API and routes carry that
// pair as one opaque, URL-safe token.
export function testId(record: Pick<TestRecord, 'file' | 'title'>): string {
    return Buffer.from(JSON.stringify([record.file, record.title]), 'utf-8').toString('base64url');
}

function decodeTestId(id: string): { file: string; title: string } | null {
    try {
        const decoded = JSON.parse(Buffer.from(id, 'base64url').toString('utf-8'));
        if (Array.isArray(decoded) && typeof decoded[0] === 'string' && typeof decoded[1] === 'string') {
            return { file: decoded[0], title: decoded[1] };
        }
    } catch { }
    return null;
}

// ── Data loading ───────────────────────────────────────────────────

export function loadTestRecords(dir: string): TestRecord[] {
    const tests: TestRecord[] = [];
    for (const jsonFile of listSpecJsonFiles(dir)) {
        const records = readSpecRecords(path.join(dir, jsonFile));
        if (records) tests.push(...records.tests);
    }
    return tests;
}

function findTestRecord(dir: string, file: string, title: string): TestRecord | undefined {
    const records = readSpecRecords(path.join(dir, specJsonName(file)));
    return records?.tests.find((test) => test.file === file && test.title === title);
}

// ── Step alignment ─────────────────────────────────────────────────

type AlignEntry =
    | { kind: 'image'; step: ImageStepRecord; filePath: string | undefined }
    | { kind: 'gap'; text: string };

export function buildAlignEntries(dir: string, steps: StepRecord[]): AlignEntry[] {
    return steps.map((step) => {
        if (isGapStep(step)) return { kind: 'gap' as const, text: step.gap };
        const file = findScreenshotFile(dir, step.image);
        return { kind: 'image' as const, step, filePath: file ? path.join(dir, file) : undefined };
    });
}

// A comparison that cannot be made is reported as a difference. The alternative —
// letting the error escape — has the caller decide what a missing answer means,
// and the summary view answers "unchanged": a test whose baseline is unreadable
// then shows a green check, which is exactly how a real regression goes unseen.
// Reporting it as changed puts the step in front of the reviewer instead.
async function entriesEquivalent(accepted: AlignEntry, current: AlignEntry): Promise<boolean> {
    if (accepted.kind === 'gap' || current.kind === 'gap') {
        return accepted.kind === 'gap' && current.kind === 'gap' && accepted.text === current.text;
    }
    // A step is what happened as much as how it looked: the same screenshot
    // reached by a different set of checks or actions is a change the
    // reviewer should see.
    if (!eventsEquivalent(accepted.step.events, current.step.events)) return false;
    // Equal hashes are pixel-identical by construction — no files needed.
    if (accepted.step.image === current.step.image) return true;
    if (!accepted.filePath || !current.filePath) return false;
    try {
        return await areImagesEquivalent(resolveExistingScreenshot(accepted.filePath), resolveExistingScreenshot(current.filePath));
    } catch (error) {
        console.warn(`ShoTest: could not compare ${accepted.filePath} with ${current.filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
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
        changed,
    };
}

// `refineMiddle` decides whether the steps between the outermost differences are
// compared or simply assumed to differ — see the middle-section comment below.
async function alignSteps(
    accepted: AlignEntry[],
    current: AlignEntry[],
    refineMiddle = false,
): Promise<AlignedPair[]> {
    const result: AlignedPair[] = [];

    let prefixLength = 0;
    const sharedLength = Math.min(accepted.length, current.length);
    while (prefixLength < sharedLength) {
        if (!(await entriesEquivalent(accepted[prefixLength], current[prefixLength]))) {
            break;
        }
        result.push(makeAlignedPair(accepted[prefixLength], current[prefixLength], false));
        prefixLength++;
    }

    let acceptedTail = accepted.length - 1;
    let currentTail = current.length - 1;
    const suffix: AlignedPair[] = [];
    while (acceptedTail >= prefixLength && currentTail >= prefixLength) {
        if (!(await entriesEquivalent(accepted[acceptedTail], current[currentTail]))) {
            break;
        }
        suffix.push(makeAlignedPair(accepted[acceptedTail], current[currentTail], false));
        acceptedTail--;
        currentTail--;
    }

    const acceptedMiddle = accepted.slice(prefixLength, acceptedTail + 1);
    const currentMiddle = current.slice(prefixLength, currentTail + 1);

    // Trimming an equal prefix and suffix locates the region that changed, but says
    // nothing about the steps inside it: a run that alters the first and last
    // screenshot leaves every screenshot between them in here, unchanged. Pairing
    // them by index and calling them all changed is fine for a yes/no verdict and
    // free, which is why the summary keeps doing it — the first middle pair is the
    // one that broke the prefix walk, so the verdict cannot come out differently.
    // A reviewer needs better: flipping between two identical screenshots looking
    // for a difference that was never there is worse than the comparison it saves.
    // Refining costs one comparison per middle step, only on tests already known to
    // have changed, and it corrects index-paired steps either side of an inserted
    // or deleted screenshot too.
    let acceptedIndex = 0;
    let currentIndex = 0;
    while (acceptedIndex < acceptedMiddle.length && currentIndex < currentMiddle.length) {
        const acceptedEntry = acceptedMiddle[acceptedIndex];
        const currentEntry = currentMiddle[currentIndex];
        // Never pair a gap with an image: emit the gap on its own so the pair
        // slots stay image-vs-image (which is what the compare view can show).
        if (acceptedEntry.kind !== currentEntry.kind) {
            if (acceptedEntry.kind === 'gap') {
                result.push(makeAlignedPair(acceptedEntry, undefined, true));
                acceptedIndex++;
            } else {
                result.push(makeAlignedPair(undefined, currentEntry, true));
                currentIndex++;
            }
            continue;
        }
        const changed = !refineMiddle || !(await entriesEquivalent(acceptedEntry, currentEntry));
        result.push(makeAlignedPair(acceptedEntry, currentEntry, changed));
        acceptedIndex++;
        currentIndex++;
    }

    for (; acceptedIndex < acceptedMiddle.length; acceptedIndex++) {
        result.push(makeAlignedPair(acceptedMiddle[acceptedIndex], undefined, true));
    }

    for (; currentIndex < currentMiddle.length; currentIndex++) {
        result.push(makeAlignedPair(undefined, currentMiddle[currentIndex], true));
    }

    result.push(...suffix.reverse());
    return result;
}

// Whether an aligned pair is something a reviewer has to look at: one side is
// missing (a step was added or removed), or the two sides differ. A side counts
// as present when its field is *there* — not when it is truthy. A gap step whose
// text is empty (withoutScreenshots('')) is still a step on that side; calling
// it missing reports a change the review app then shows as unchanged, leaving a
// warning marker that cannot be inspected and an Accept button that never
// appears. The review app's own getStepChange() applies the same rule; the two
// must agree, or the summary and the detail view contradict each other.
function pairHasChange(step: AlignedPair): boolean {
    const hasAccepted = step.acceptedImage !== undefined || step.acceptedGap !== undefined;
    const hasCurrent = step.currentImage !== undefined || step.currentGap !== undefined;
    return step.changed || !hasAccepted || !hasCurrent;
}

export async function hasVisualChanges(acceptedEntries: AlignEntry[], currentEntries: AlignEntry[]): Promise<boolean> {
    const steps = await alignSteps(acceptedEntries, currentEntries);
    return steps.some(pairHasChange);
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
}

// Stands in for the source file of an orphaned baseline (whose spec may no
// longer exist), grouping them together at the bottom of the review app's list.
const orphanedGroupLabel = 'not in test-results/';

async function getTests(): Promise<TestSummary[]> {
    const currentTests = loadTestRecords(outputDir);
    const acceptedTests = loadTestRecords(acceptedDir);
    const acceptedByKey = new Map(acceptedTests.map((test) => [testId(test), test]));

    const tests = await Promise.all(currentTests.map(async (record) => {
        const currentEntries = buildAlignEntries(outputDir, record.steps);
        const acceptedRecord = acceptedByKey.get(testId(record));
        const acceptedEntries = buildAlignEntries(acceptedDir, acceptedRecord?.steps ?? []);
        return {
            id: testId(record),
            file: record.file,
            line: record.line ?? 0,
            title: record.title,
            status: record.status ?? 'unknown',
            hasChanges: await hasVisualChanges(acceptedEntries, currentEntries),
            orphaned: false,
        };
    }));

    // Baselines without a matching test in test-results: the test was renamed
    // or deleted — or it simply wasn't part of this run. Listing them (last) is
    // what makes them deletable from the review app; nothing else ever cleans
    // them up, so otherwise they linger in version control forever.
    const currentKeys = new Set(currentTests.map((test) => testId(test)));
    for (const record of acceptedTests) {
        if (currentKeys.has(testId(record)) || record.steps.length === 0) continue;
        tests.push({
            id: testId(record),
            file: orphanedGroupLabel,
            line: 0,
            title: `${record.file} › ${record.title}`,
            status: 'orphaned',
            hasChanges: true,
            orphaned: true,
        });
    }

    return tests.sort((a, b) =>
        Number(a.orphaned) - Number(b.orphaned) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.title.localeCompare(b.title)
    );
}

async function getTestDetails(file: string, title: string): Promise<{
    manifest: TestRecord | null;
    steps: AlignedPair[];
    canRevert: boolean;
    orphaned: boolean;
}> {
    const currentRecord = findTestRecord(outputDir, file, title);
    const acceptedRecord = findTestRecord(acceptedDir, file, title);
    const acceptedEntries = buildAlignEntries(acceptedDir, acceptedRecord?.steps ?? []);

    if (!currentRecord) {
        // No test ran under this identity. If a baseline is still there, align
        // it against nothing: every step comes out as removed, so the review
        // app can show what the stale baseline holds before it is dropped.
        return {
            manifest: null,
            steps: await alignSteps(acceptedEntries, []),
            canRevert: canRevertTest(file, title),
            orphaned: !!acceptedRecord,
        };
    }

    const currentEntries = buildAlignEntries(outputDir, currentRecord.steps);

    // Worth the extra comparisons here: this is the view where a step marked
    // changed sends someone looking for the difference.
    const steps = await alignSteps(acceptedEntries, currentEntries, true);
    return { manifest: currentRecord, steps, canRevert: canRevertTest(file, title), orphaned: false };
}

// ── Accepting ──────────────────────────────────────────────────────

// The baseline keeps only what identifies, orders and displays the steps; run
// metadata (durations, console output, source lines — which shift on every
// edit) would churn version control without informing a later comparison.
// Event types/messages take part in the comparison; boxes and the viewport
// are kept so the review app can point at what a baseline-only step targeted.
function stripForAccept(record: TestRecord): TestRecord {
    return {
        file: record.file,
        title: record.title,
        steps: record.steps.map((step) => {
            if (isGapStep(step)) return { gap: step.gap };
            const events = significantEvents(step.events).map(({ type, message, box }) => ({ type, message, box }));
            return {
                image: step.image,
                viewport: step.viewport,
                events: events.length > 0 ? events : undefined,
                role: step.role,
            };
        }),
    };
}

function removeTestRecord(dir: string, file: string, title: string): void {
    const jsonPath = path.join(dir, specJsonName(file));
    if (!fs.existsSync(jsonPath)) return;
    withFileLock(jsonPath, () => {
        const records = readSpecRecords(jsonPath);
        if (!records) return;
        records.tests = records.tests.filter((test) => test.file !== file || test.title !== title);
        if (records.tests.length === 0) fs.rmSync(jsonPath, { force: true });
        else writeSpecRecords(jsonPath, records);
    });
}

function acceptTest(file: string, title: string): void {
    const currentRecord = findTestRecord(outputDir, file, title);

    // The test produced no record (orphaned baseline) or no screenshots at all:
    // accepting that state means dropping the baseline it left behind. The
    // review app only offers this once it has shown what is about to go.
    if (!currentRecord || currentRecord.steps.length === 0) {
        removeTestRecord(acceptedDir, file, title);
        gcPoolFiles(acceptedDir);
        return;
    }

    fs.mkdirSync(acceptedDir, { recursive: true });

    // Copy images into the pool first, JSON second: a reader following the
    // JSON must find every file it references. Files already in the pool —
    // as PNG or as recompressed WebP — are pixel-identical by construction
    // and are left alone.
    for (const step of currentRecord.steps) {
        if (isGapStep(step)) continue;
        if (findScreenshotFile(acceptedDir, step.image)) continue;
        const sourceFile = findScreenshotFile(outputDir, step.image);
        if (!sourceFile) {
            console.warn(`ShoTest: missing ${step.image} in ${outputDir}, baseline will be incomplete`);
            continue;
        }
        fs.copyFileSync(path.join(outputDir, sourceFile), path.join(acceptedDir, step.image + path.extname(sourceFile)));
    }

    mergeTestRecord(acceptedDir, stripForAccept(currentRecord));

    // A replaced baseline may have been the last reference to some pool images.
    gcPoolFiles(acceptedDir);

    // Baselines get committed, so shrink them — lossless, but slow enough that
    // the review UI should not wait for it. Until a file is converted, the PNG
    // copy above is what gets served and compared.
    void compressAcceptedPool(acceptedDir);
}

// ── Reverting from git ─────────────────────────────────────────────

function acceptedJsonGitPath(file: string): string {
    // "HEAD:./path" makes git resolve the path relative to the cwd.
    return './' + path.relative(process.cwd(), path.resolve(path.join(acceptedDir, specJsonName(file)))).split(path.sep).join('/');
}

function findHeadTestRecord(file: string, title: string): TestRecord | undefined {
    try {
        const json = execFileSync('git', ['show', 'HEAD:' + acceptedJsonGitPath(file)], {
            encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        const records = JSON.parse(json);
        if (Array.isArray(records?.tests)) {
            return records.tests.find((test: TestRecord) => test.file === file && test.title === title);
        }
    } catch { }
    return undefined;
}

function canRevertTest(file: string, title: string): boolean {
    const headRecord = findHeadTestRecord(file, title);
    const workingRecord = findTestRecord(acceptedDir, file, title);
    return JSON.stringify(headRecord ?? null) !== JSON.stringify(workingRecord ?? null);
}

function restorePoolFileFromGit(hash: string): boolean {
    for (const ext of imageExtensions) {
        const gitPath = './' + path.relative(process.cwd(), path.resolve(path.join(acceptedDir, hash + ext))).split(path.sep).join('/');
        try {
            execFileSync('git', ['checkout', 'HEAD', '--', gitPath], { stdio: 'ignore' });
            return true;
        } catch { }
    }
    return false;
}

function revertAcceptedTest(file: string, title: string): void {
    const headRecord = findHeadTestRecord(file, title);
    if (!headRecord) {
        removeTestRecord(acceptedDir, file, title);
    } else {
        mergeTestRecord(acceptedDir, headRecord);
        // Content addressing makes image restore precise: the images the HEAD
        // baseline references still exist in git under the same names.
        for (const step of headRecord.steps) {
            if (isGapStep(step) || findScreenshotFile(acceptedDir, step.image)) continue;
            if (!restorePoolFileFromGit(step.image)) {
                console.warn(`ShoTest: could not restore ${step.image} from git`);
            }
        }
    }
    // Drop pool images only the reverted-away baseline referenced.
    gcPoolFiles(acceptedDir);
}

// ── HTTP Server ────────────────────────────────────────────────────

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
    try {
        const data = fs.readFileSync(filePath);
        // Baseline JSONs change under stable URLs, and while pool images are
        // content-addressed, a hash URL's *format* (png/webp) can still swap.
        // A cached copy would leave the reviewer toggling between two
        // renderings of the same image, which reads as "nothing changed" —
        // the one conclusion this app must never invent.
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

function readTestId(res: http.ServerResponse, encoded: string): { file: string; title: string } | null {
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

function resolveReviewDirectory(dirPath: string): string {
    return path.resolve(process.cwd(), dirPath);
}

function announceServer(port: number, openBrowser: boolean) {
    const url = `http://localhost:${port}`;
    console.log(`- uri: ${url}\n`);

    if (!openBrowser) {
        return;
    }

    // Try to open browser
    try {
        const platform = process.platform;
        if (platform === 'linux') execSync(`xdg-open ${url}`, { stdio: 'ignore' });
        else if (platform === 'darwin') execSync(`open ${url}`, { stdio: 'ignore' });
        else if (platform === 'win32') execSync(`start ${url}`, { stdio: 'ignore' });
    } catch { }
}

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

    // Spec JSONs from an older format version are ignored, so their tests
    // read as never-accepted (all steps "new") — accepting rebuilds them in
    // the current format. Say so, or the silent downgrade looks like a bug.
    const outdatedBaselines = listSpecJsonFiles(resolvedAcceptedDir)
        .filter((file) => isOutdatedSpecJson(path.join(resolvedAcceptedDir, file)));
    if (outdatedBaselines.length > 0) {
        console.warn(`ShoTest Review: ignoring ${outdatedBaselines.length} baseline JSON(s) in ${acceptedDir} written by an older ShoTest version (${outdatedBaselines.join(', ')}). Their tests show as new; accepting them records a fresh baseline.`);
    }

    if (listSpecJsonFiles(resolvedOutputDir).length === 0 &&
        fs.readdirSync(resolvedOutputDir, { withFileTypes: true })
            .some((entry) => entry.isDirectory() && fs.existsSync(path.join(resolvedOutputDir, entry.name, 'manifest.json')))) {
        console.warn('ShoTest Review: test-results looks like output from ShoTest 1.x — rerun your tests to produce 2.x results.');
    }

    // Finish any pool compression a previous session left half done.
    void compressAcceptedPool(resolvedAcceptedDir);

    let currentPort = preferredPort;

    const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url || '/', `http://localhost:${currentPort}`);
        const pathname = url.pathname;

        try {
            // CORS for dev
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/image/')) {
                serveFile(res, reviewUiPath, 'text/html; charset=utf-8');
                return;
            }

            if (pathname === '/api/tests') {
                serveJson(res, await getTests());
                return;
            }

            const testDetailMatch = pathname.match(/^\/api\/test\/(.+)/);
            if (testDetailMatch && req.method === 'GET') {
                const id = readTestId(res, testDetailMatch[1]);
                if (!id) return;
                serveJson(res, await getTestDetails(id.file, id.title));
                return;
            }

            const acceptMatch = pathname.match(/^\/api\/accept\/(.+)/);
            if (acceptMatch && req.method === 'POST') {
                const id = readTestId(res, acceptMatch[1]);
                if (!id) return;
                acceptTest(id.file, id.title);
                serveJson(res, { ok: true });
                return;
            }

            const revertMatch = pathname.match(/^\/api\/revert\/(.+)/);
            if (revertMatch && req.method === 'POST') {
                const id = readTestId(res, revertMatch[1]);
                if (!id) return;
                revertAcceptedTest(id.file, id.title);
                serveJson(res, { ok: true });
                return;
            }

            // Images are addressed by bare hash; the server resolves whichever
            // format (png/webp) the pool holds at this moment.
            const imageMatch = pathname.match(/^\/image\/(current|accepted)\/([0-9a-f]{16})$/);
            if (imageMatch) {
                const baseDir = imageMatch[1] === 'current' ? outputDir : acceptedDir;
                const file = findScreenshotFile(baseDir, imageMatch[2]);
                if (!file) {
                    res.writeHead(404);
                    res.end('Not found');
                    return;
                }
                const contentType = file.endsWith('.webp') ? 'image/webp' : 'image/png';
                serveFile(res, path.join(baseDir, file), contentType);
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
