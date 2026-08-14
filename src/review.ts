/**
 * ShoTest Review Server
 *
 * A simple Node.js HTTP server that serves a review UI for comparing
 * test screenshots against accepted baselines.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { areImagesEquivalent } from './visual-compare.js';
import { compressDirectoryToWebp } from './webp.js';
import type { ConsoleMessageInfo, TestManifest } from './fixture.js';

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
// recompressed to lossless WebP afterwards. Both are read back. A name exists in
// both formats only while a background conversion is still working on it, and
// there the PNG is the copy to trust: the WebP is written first and the PNG only
// removed once it is on disk, so a PNG that is still around either predates its
// WebP or outlived a conversion that a newer accept cancelled.
const imageExtensions = ['.png', '.webp'];

function isScreenshotFile(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    return imageExtensions.includes(ext) && path.basename(file, ext) !== 'error';
}

function findScreenshotFile(dir: string, name: string): string | undefined {
    return imageExtensions.map((ext) => name + ext).find((file) => fs.existsSync(path.join(dir, file)));
}

// ── Image alignment ────────────────────────────────────────────────

interface ImageEntry {
    name: string;
    file: string;
    filePath: string;
    source: string;
    duration: number | undefined;
    role: string | undefined;
    consoleMessages: ConsoleMessageInfo[] | undefined;
}

interface AlignedPair {
    acceptedImage: string | undefined;
    currentImage: string | undefined;
    location: string;
    duration: number | undefined;
    role: string | undefined;
    consoleMessages: ConsoleMessageInfo[] | undefined;
    changed: boolean;
}

async function alignImages(accepted: ImageEntry[], current: ImageEntry[]): Promise<AlignedPair[]> {
    function makeAlignedPair(
        acceptedEntry: ImageEntry | undefined,
        currentEntry: ImageEntry | undefined,
        changed: boolean,
    ): AlignedPair {
        const imageEntry = currentEntry ?? acceptedEntry!;
        return {
            acceptedImage: acceptedEntry?.file,
            currentImage: currentEntry?.file,
            location: imageEntry.source,
            duration: imageEntry.duration,
            role: currentEntry?.role ?? acceptedEntry?.role,
            consoleMessages: currentEntry?.consoleMessages ?? acceptedEntry?.consoleMessages,
            changed,
        };
    }

    const result: AlignedPair[] = [];

    let prefixLength = 0;
    const sharedLength = Math.min(accepted.length, current.length);
    while (prefixLength < sharedLength) {
        if (!(await areImagesEquivalent(accepted[prefixLength].filePath, current[prefixLength].filePath))) {
            break;
        }
        result.push(makeAlignedPair(accepted[prefixLength], current[prefixLength], false));
        prefixLength++;
    }

    let acceptedTail = accepted.length - 1;
    let currentTail = current.length - 1;
    const suffix: AlignedPair[] = [];
    while (acceptedTail >= prefixLength && currentTail >= prefixLength) {
        if (!(await areImagesEquivalent(accepted[acceptedTail].filePath, current[currentTail].filePath))) {
            break;
        }
        suffix.push(makeAlignedPair(accepted[acceptedTail], current[currentTail], false));
        acceptedTail--;
        currentTail--;
    }

    const acceptedMiddle = accepted.slice(prefixLength, acceptedTail + 1);
    const currentMiddle = current.slice(prefixLength, currentTail + 1);
    const changedPairs = Math.min(acceptedMiddle.length, currentMiddle.length);

    for (let index = 0; index < changedPairs; index++) {
        result.push(makeAlignedPair(acceptedMiddle[index], currentMiddle[index], true));
    }

    for (let index = changedPairs; index < acceptedMiddle.length; index++) {
        result.push(makeAlignedPair(acceptedMiddle[index], undefined, true));
    }

    for (let index = changedPairs; index < currentMiddle.length; index++) {
        result.push(makeAlignedPair(undefined, currentMiddle[index], true));
    }

    result.push(...suffix.reverse());
    return result;
}

export function loadCurrentImageEntries(testDir: string, manifest: TestManifest): ImageEntry[] {
    const entries: ImageEntry[] = [];

    for (const step of manifest.steps) {
        const file = findScreenshotFile(testDir, step.name);
        if (!file) continue;

        entries.push({
            name: step.name,
            file,
            filePath: path.join(testDir, file),
            source: step.source,
            duration: step.duration,
            role: step.role,
            consoleMessages: step.consoleMessages,
        });
    }

    return entries;
}

export function loadAcceptedImageEntries(expDir: string): ImageEntry[] {
    if (!fs.existsSync(expDir)) {
        return [];
    }

    // A name can briefly exist as both .png and .webp, while a background
    // conversion is running; collect names and let findScreenshotFile pick.
    const names = new Set<string>();
    for (const file of fs.readdirSync(expDir)) {
        if (isScreenshotFile(file)) {
            names.add(file.slice(0, -path.extname(file).length));
        }
    }

    return [...names].sort().map((name: string) => {
        const file = findScreenshotFile(expDir, name)!;
        return {
            name,
            file,
            filePath: path.join(expDir, file),
            source: name,
            duration: undefined,
            role: undefined,
            consoleMessages: undefined,
        };
    });
}

export async function hasVisualChanges(acceptedEntries: ImageEntry[], currentEntries: ImageEntry[]): Promise<boolean> {
    const steps = await alignImages(acceptedEntries, currentEntries);
    return steps.some((step) => step.changed || !step.acceptedImage || !step.currentImage);
}

interface TestSummary {
    name: string;
    file: string;
    line: number;
    title: string;
    status: string;
    hasChanges: boolean;
    orphaned: boolean;
}

// Stands in for the source file of an orphaned baseline (which we have no way of
// knowing), grouping them together at the bottom of the review app's test list.
const orphanedGroupLabel = 'not in test-results/';

function listTestDirectories(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d: fs.Dirent) => d.isDirectory())
        .map((d: fs.Dirent) => d.name);
}

async function getTests(): Promise<TestSummary[]> {
    const currentNames = listTestDirectories(outputDir);

    const tests = await Promise.all(currentNames.map(async (name: string) => {
        const manifestPath = path.join(outputDir, name, 'manifest.json');
        let file = name;
        let line = 0;
        let title = name;
        let status = 'unknown';
        let hasChanges = false;

        if (fs.existsSync(manifestPath)) {
            try {
                const manifest: TestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                file = manifest.file;
                line = manifest.line;
                title = manifest.title;
                status = manifest.status;

                const testDir = path.join(outputDir, name);
                const expDir = path.join(acceptedDir, name);
                hasChanges = await hasVisualChanges(
                    loadAcceptedImageEntries(expDir),
                    loadCurrentImageEntries(testDir, manifest),
                );
            } catch { }
        }

        return { name, file, line, title, status, hasChanges, orphaned: false };
    }));

    // Baselines without a matching test-results directory: the test was renamed
    // or deleted — or it simply wasn't part of this run. Listing them (last) is
    // what makes them deletable from the review app; nothing else ever cleans
    // them up, so otherwise they linger in version control forever.
    const currentNameSet = new Set(currentNames);
    for (const name of listTestDirectories(acceptedDir)) {
        if (currentNameSet.has(name)) continue;
        if (loadAcceptedImageEntries(path.join(acceptedDir, name)).length === 0) continue;

        tests.push({
            name,
            file: orphanedGroupLabel,
            line: 0,
            // The directory name is all we have: the title it was derived from
            // lives in a manifest that only test-results carries.
            title: name,
            status: 'orphaned',
            hasChanges: true,
            orphaned: true,
        });
    }

    return tests.sort((a, b) =>
        Number(a.orphaned) - Number(b.orphaned) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.name.localeCompare(b.name)
    );
}

async function getTestDetails(testName: string): Promise<{
    manifest: TestManifest | null;
    steps: AlignedPair[];
    canRevert: boolean;
    orphaned: boolean;
}> {
    const testDir = path.join(outputDir, testName);
    const manifestPath = path.join(testDir, 'manifest.json');
    const expDir = path.join(acceptedDir, testName);

    if (!fs.existsSync(manifestPath)) {
        // No test ran under this name. If a baseline is still there, align it
        // against nothing: every step comes out as removed, so the review app
        // can show what the stale baseline holds before it is dropped.
        const acceptedEntries = fs.existsSync(testDir) ? [] : loadAcceptedImageEntries(expDir);
        const orphaned = acceptedEntries.length > 0;
        return {
            manifest: null,
            steps: await alignImages(acceptedEntries, []),
            canRevert: orphaned && hasAcceptedWorktreeChanges(testName),
            orphaned,
        };
    }

    const manifest: TestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const currentEntries = loadCurrentImageEntries(testDir, manifest);
    const acceptedEntries = loadAcceptedImageEntries(expDir);

    const steps = await alignImages(acceptedEntries, currentEntries);
    return { manifest, steps, canRevert: hasAcceptedWorktreeChanges(testName), orphaned: false };
}

// Bumped on every accept, so a conversion still running for an earlier accept of
// the same test stops touching a directory that has since been replaced.
const acceptGenerations = new Map<string, number>();

function acceptTest(testName: string): void {
    const testDir = path.join(outputDir, testName);
    const expDir = path.join(acceptedDir, testName);

    if (!fs.existsSync(testDir) && !fs.existsSync(expDir)) return;

    const generation = (acceptGenerations.get(expDir) ?? 0) + 1;
    acceptGenerations.set(expDir, generation);

    // The test produced no output at all: accepting that state means dropping the
    // baseline it left behind. Nothing prunes these otherwise, and the review app
    // only offers this once it has shown what is about to go.
    if (!fs.existsSync(testDir)) {
        fs.rmSync(expDir, { recursive: true, force: true });
        return;
    }

    // Clear existing accepted dir
    if (fs.existsSync(expDir)) {
        fs.rmSync(expDir, { recursive: true });
    }
    fs.mkdirSync(expDir, { recursive: true });

    const files = fs.readdirSync(testDir).filter(isScreenshotFile);
    for (const file of files) {
        fs.copyFileSync(path.join(testDir, file), path.join(expDir, file));
    }

    // Baselines get committed, so shrink them — lossless, but slow enough that
    // the review UI should not wait for it. Until a file is converted, the PNG
    // copy above is what gets served and compared.
    void compressDirectoryToWebp(expDir, () => acceptGenerations.get(expDir) !== generation);
}

function getAcceptedGitPathspec(testName: string): string {
    return path.relative(process.cwd(), path.resolve(path.join(acceptedDir, testName))).split(path.sep).join('/');
}

function acceptedPathExistsAtHead(pathspec: string): boolean {
    try {
        return execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', pathspec], {
            encoding: 'utf-8',
        }).trim().length > 0;
    } catch {
        return false;
    }
}

function listUntrackedAcceptedPaths(pathspec: string): string[] {
    try {
        return execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', pathspec], {
            encoding: 'utf-8',
        })
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

function hasAcceptedWorktreeChanges(testName: string): boolean {
    const pathspec = getAcceptedGitPathspec(testName);

    try {
        return execFileSync('git', ['status', '--porcelain', '--', pathspec], {
            encoding: 'utf-8',
        }).trim().length > 0;
    } catch {
        return false;
    }
}

function revertAcceptedTest(testName: string): void {
    const expDir = path.join(acceptedDir, testName);
    const pathspec = getAcceptedGitPathspec(testName);
    const existsAtHead = acceptedPathExistsAtHead(pathspec);

    try {
        execFileSync('git', ['checkout', '--', pathspec], { stdio: 'ignore' });
    } catch (error) {
        if (existsAtHead) {
            throw error;
        }
    }

    if (!existsAtHead) {
        fs.rmSync(expDir, { recursive: true, force: true });
        return;
    }

    for (const untrackedPath of listUntrackedAcceptedPaths(pathspec)) {
        fs.rmSync(path.resolve(process.cwd(), untrackedPath), { recursive: true, force: true });
    }
}

// ── HTTP Server ────────────────────────────────────────────────────

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
    try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

// Test names name a single directory below the output/accepted dirs, so anything
// that could climb out of them is a malformed request — worth rejecting up front,
// since accepting an orphan deletes a directory outright.
function readTestName(res: http.ServerResponse, encoded: string): string | null {
    const name = decodeURIComponent(encoded);
    if (name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')) {
        return name;
    }

    res.writeHead(400);
    res.end('Invalid test name');
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
                const testName = readTestName(res, testDetailMatch[1]);
                if (!testName) return;
                serveJson(res, await getTestDetails(testName));
                return;
            }

            const acceptMatch = pathname.match(/^\/api\/accept\/(.+)/);
            if (acceptMatch && req.method === 'POST') {
                const testName = readTestName(res, acceptMatch[1]);
                if (!testName) return;
                acceptTest(testName);
                serveJson(res, { ok: true });
                return;
            }

            const revertMatch = pathname.match(/^\/api\/revert\/(.+)/);
            if (revertMatch && req.method === 'POST') {
                const testName = readTestName(res, revertMatch[1]);
                if (!testName) return;
                revertAcceptedTest(testName);
                serveJson(res, { ok: true });
                return;
            }

            const imageMatch = pathname.match(/^\/image\/(current|accepted)\/(.+)/);
            if (imageMatch) {
                const baseDir = imageMatch[1] === 'current' ? outputDir : acceptedDir;
                const filePath = path.join(baseDir, imageMatch[2]);
                const resolved = path.resolve(filePath);
                const resolvedBase = path.resolve(baseDir);
                if (!resolved.startsWith(resolvedBase)) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }
                // A background conversion may have replaced the file with its
                // other format between listing and loading it; serve that instead
                // of a 404.
                let servePath = resolved;
                if (!fs.existsSync(servePath) && isScreenshotFile(servePath)) {
                    const dir = path.dirname(servePath);
                    const alternate = findScreenshotFile(dir, path.basename(servePath, path.extname(servePath)));
                    if (alternate) servePath = path.join(dir, alternate);
                }

                const ext = path.extname(servePath).toLowerCase();
                const mimeTypes: Record<string, string> = {
                    '.png': 'image/png',
                    '.webp': 'image/webp',
                    '.html': 'text/html; charset=utf-8',
                    '.txt': 'text/plain; charset=utf-8',
                    '.json': 'application/json',
                };
                serveFile(res, servePath, mimeTypes[ext] || 'application/octet-stream');
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
