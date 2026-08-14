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
}

async function getTests(): Promise<TestSummary[]> {
    if (!fs.existsSync(outputDir)) return [];

    const dirs = fs.readdirSync(outputDir, { withFileTypes: true })
        .filter((d: fs.Dirent) => d.isDirectory())
        .map((d: fs.Dirent) => d.name);

    const tests = await Promise.all(dirs.map(async (name: string) => {
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

        return { name, file, line, title, status, hasChanges };
    }));

    return tests.sort((a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.name.localeCompare(b.name)
    );
}

async function getTestDetails(testName: string): Promise<{
    manifest: TestManifest | null;
    steps: AlignedPair[];
    canRevert: boolean;
}> {
    const testDir = path.join(outputDir, testName);
    const manifestPath = path.join(testDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        return { manifest: null, steps: [], canRevert: false };
    }

    const manifest: TestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const expDir = path.join(acceptedDir, testName);

    const currentEntries = loadCurrentImageEntries(testDir, manifest);
    const acceptedEntries = loadAcceptedImageEntries(expDir);

    const steps = await alignImages(acceptedEntries, currentEntries);
    return { manifest, steps, canRevert: hasAcceptedWorktreeChanges(testName) };
}

// Bumped on every accept, so a conversion still running for an earlier accept of
// the same test stops touching a directory that has since been replaced.
const acceptGenerations = new Map<string, number>();

function acceptTest(testName: string): void {
    const testDir = path.join(outputDir, testName);
    const expDir = path.join(acceptedDir, testName);

    if (!fs.existsSync(testDir)) return;

    const generation = (acceptGenerations.get(expDir) ?? 0) + 1;
    acceptGenerations.set(expDir, generation);

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
                serveJson(res, await getTestDetails(decodeURIComponent(testDetailMatch[1])));
                return;
            }

            const acceptMatch = pathname.match(/^\/api\/accept\/(.+)/);
            if (acceptMatch && req.method === 'POST') {
                acceptTest(decodeURIComponent(acceptMatch[1]));
                serveJson(res, { ok: true });
                return;
            }

            const revertMatch = pathname.match(/^\/api\/revert\/(.+)/);
            if (revertMatch && req.method === 'POST') {
                revertAcceptedTest(decodeURIComponent(revertMatch[1]));
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
