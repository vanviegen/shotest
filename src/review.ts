/**
 * ShoTest Review Server
 *
 * A simple Node.js HTTP server that serves a review UI for comparing
 * test screenshots against accepted baselines.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { areImagesEquivalent } from './visual-compare.js';
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

// ── Sequence alignment (Needleman-Wunsch) ──────────────────────────

interface ImageEntry {
    name: string;
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

const alignmentResyncLookahead = 12;

async function alignImages(accepted: ImageEntry[], current: ImageEntry[]): Promise<AlignedPair[]> {
    function makeAlignedPair(
        acceptedEntry: ImageEntry | undefined,
        currentEntry: ImageEntry | undefined,
        changed: boolean,
    ): AlignedPair {
        const imageEntry = currentEntry ?? acceptedEntry!;
        return {
            acceptedImage: acceptedEntry ? acceptedEntry.name + '.png' : undefined,
            currentImage: currentEntry ? currentEntry.name + '.png' : undefined,
            location: imageEntry.source,
            duration: imageEntry.duration,
            role: currentEntry?.role ?? acceptedEntry?.role,
            consoleMessages: currentEntry?.consoleMessages ?? acceptedEntry?.consoleMessages,
            changed,
        };
    }

    function findNameAhead(entries: ImageEntry[], startIndex: number, name: string): number {
        const endIndex = Math.min(entries.length, startIndex + alignmentResyncLookahead + 1);
        for (let index = startIndex + 1; index < endIndex; index++) {
            if (entries[index].name === name) {
                return index;
            }
        }
        return -1;
    }

    const result: AlignedPair[] = [];
    let acceptedIndex = 0;
    let currentIndex = 0;

    while (acceptedIndex < accepted.length || currentIndex < current.length) {
        const acceptedEntry = accepted[acceptedIndex];
        const currentEntry = current[currentIndex];

        if (!acceptedEntry) {
            result.push(makeAlignedPair(undefined, currentEntry, true));
            currentIndex++;
            continue;
        }

        if (!currentEntry) {
            result.push(makeAlignedPair(acceptedEntry, undefined, true));
            acceptedIndex++;
            continue;
        }

        if (acceptedEntry.name === currentEntry.name) {
            result.push(makeAlignedPair(
                acceptedEntry,
                currentEntry,
                !(await areImagesEquivalent(acceptedEntry.filePath, currentEntry.filePath)),
            ));
            acceptedIndex++;
            currentIndex++;
            continue;
        }

        const nextCurrentMatch = findNameAhead(current, currentIndex, acceptedEntry.name);
        const nextAcceptedMatch = findNameAhead(accepted, acceptedIndex, currentEntry.name);

        if (nextCurrentMatch === -1 && nextAcceptedMatch === -1) {
            result.push(makeAlignedPair(acceptedEntry, currentEntry, true));
            acceptedIndex++;
            currentIndex++;
            continue;
        }

        if (nextCurrentMatch !== -1 && (nextAcceptedMatch === -1 || nextCurrentMatch - currentIndex <= nextAcceptedMatch - acceptedIndex)) {
            while (currentIndex < nextCurrentMatch) {
                result.push(makeAlignedPair(undefined, current[currentIndex], true));
                currentIndex++;
            }
            continue;
        }

        while (acceptedIndex < nextAcceptedMatch) {
            result.push(makeAlignedPair(accepted[acceptedIndex], undefined, true));
            acceptedIndex++;
        }
    }

    return result;
}

function loadCurrentImageEntries(testDir: string, manifest: TestManifest): ImageEntry[] {
    return manifest.steps
        .filter((step) => fs.existsSync(path.join(testDir, step.name + '.png')))
        .map((step) => ({
            name: step.name,
            filePath: path.join(testDir, step.name + '.png'),
            source: step.source,
            duration: step.duration,
            role: step.role,
            consoleMessages: step.consoleMessages,
        }));
}

function loadAcceptedImageEntries(expDir: string): ImageEntry[] {
    if (!fs.existsSync(expDir)) {
        return [];
    }

    const acceptedManifestPath = path.join(expDir, 'manifest.json');
    if (fs.existsSync(acceptedManifestPath)) {
        try {
            const acceptedManifest: TestManifest = JSON.parse(fs.readFileSync(acceptedManifestPath, 'utf-8'));
            return acceptedManifest.steps
                .filter((step) => fs.existsSync(path.join(expDir, step.name + '.png')))
                .map((step) => ({
                    name: step.name,
                    filePath: path.join(expDir, step.name + '.png'),
                    source: step.source,
                    duration: step.duration,
                    role: step.role,
                    consoleMessages: step.consoleMessages,
                }));
        } catch {
            return [];
        }
    }

    return fs.readdirSync(expDir)
        .filter((file: string) => file.endsWith('.png') && file !== 'error.png')
        .sort()
        .map((file: string) => {
            const name = file.replace('.png', '');
            return {
                name,
                filePath: path.join(expDir, file),
                source: name,
                duration: undefined,
                role: undefined,
                consoleMessages: undefined,
            };
        });
}

async function hasVisualChanges(acceptedEntries: ImageEntry[], currentEntries: ImageEntry[]): Promise<boolean> {
    if (acceptedEntries.length !== currentEntries.length) {
        return true;
    }

    for (let index = 0; index < acceptedEntries.length; index++) {
        const acceptedEntry = acceptedEntries[index];
        const currentEntry = currentEntries[index];

        if (acceptedEntry.name !== currentEntry.name) {
            return true;
        }

        if (!(await areImagesEquivalent(acceptedEntry.filePath, currentEntry.filePath))) {
            return true;
        }
    }

    return false;
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
}> {
    const testDir = path.join(outputDir, testName);
    const manifestPath = path.join(testDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        return { manifest: null, steps: [] };
    }

    const manifest: TestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const expDir = path.join(acceptedDir, testName);

    const currentEntries = loadCurrentImageEntries(testDir, manifest);
    const acceptedEntries = loadAcceptedImageEntries(expDir);

    const steps = await alignImages(acceptedEntries, currentEntries);
    return { manifest, steps };
}

function acceptTest(testName: string): void {
    const testDir = path.join(outputDir, testName);
    const expDir = path.join(acceptedDir, testName);

    if (!fs.existsSync(testDir)) return;

    // Clear existing accepted dir
    if (fs.existsSync(expDir)) {
        fs.rmSync(expDir, { recursive: true });
    }
    fs.mkdirSync(expDir, { recursive: true });

    // Accepted baselines only need image files. Legacy accepted manifests are
    // still supported when present, but we do not write them anymore because
    // volatile metadata like durations causes unnecessary churn in git.
    const files = fs.readdirSync(testDir).filter((f: string) => f.endsWith('.png') && f !== 'error.png');
    for (const file of files) {
        fs.copyFileSync(path.join(testDir, file), path.join(expDir, file));
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

function assertReviewOutputDirExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        throw new Error(`ShoTest Review: test-dir does not exist: ${dirPath}`);
    }

    if (!fs.statSync(dirPath).isDirectory()) {
        throw new Error(`ShoTest Review: test-dir is not a directory: ${dirPath}`);
    }
}

function announceServer(port: number, openBrowser: boolean) {
    const url = `http://localhost:${port}`;
    console.log(`\nShoTest Review: ${url}\n`);

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

    assertReviewOutputDirExists(resolvedOutputDir);

    console.log(`ShoTest Review test-dir: ${resolvedOutputDir}`);
    console.log(`ShoTest Review accepted-dir: ${resolvedAcceptedDir}`);

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
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes: Record<string, string> = {
                    '.png': 'image/png',
                    '.html': 'text/html; charset=utf-8',
                    '.txt': 'text/plain; charset=utf-8',
                    '.json': 'application/json',
                };
                serveFile(res, filePath, mimeTypes[ext] || 'application/octet-stream');
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
