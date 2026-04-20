/**
 * shoTest Review Server
 *
 * A simple Node.js HTTP server that serves a review UI for comparing
 * test screenshots against accepted baselines.
 *
 * Usage:
 *   npx shotest
 *   node --experimental-strip-types shotest/src/review.ts [--port 3847]
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { TestManifest } from './fixture.ts';

// ── Configuration ──────────────────────────────────────────────────

const outputDir = process.env.SHOTEST_OUTPUT_DIR || 'test-results';
const acceptedDir = process.env.SHOTEST_ACCEPTED_DIR || 'test-accepted';
const port = parseInt(process.env.SHOTEST_PORT || '3847');
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const reviewUiPath = path.join(thisDir, '..', 'build', 'review-ui.html');

// ── Image hashing ──────────────────────────────────────────────────

function hashFile(filePath: string): string {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

// ── Sequence alignment (Needleman-Wunsch) ──────────────────────────

interface ImageEntry {
    name: string;
    hash: string;
    source: string;
    duration: number | null;
}

interface AlignedPair {
    acceptedImage: string | undefined;
    currentImage: string | undefined;
    location: string;
    duration: number | null;
    changed: boolean;
}

function alignImages(accepted: ImageEntry[], current: ImageEntry[]): AlignedPair[] {
    const m = accepted.length;
    const n = current.length;

    // DP table for edit distance
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (accepted[i - 1].hash === current[j - 1].hash) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = Math.min(
                    dp[i - 1][j - 1] + 1, // substitute
                    dp[i - 1][j] + 1,      // delete from accepted
                    dp[i][j - 1] + 1,      // insert from current
                );
            }
        }
    }

    // Traceback
    const result: AlignedPair[] = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && accepted[i - 1].hash === current[j - 1].hash) {
            result.unshift({
                acceptedImage: accepted[i - 1].name + '.png',
                currentImage: current[j - 1].name + '.png',
                location: current[j - 1].source,
                duration: current[j - 1].duration,
                changed: false,
            });
            i--; j--;
        } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
            result.unshift({
                acceptedImage: accepted[i - 1].name + '.png',
                currentImage: current[j - 1].name + '.png',
                location: current[j - 1].source,
                duration: current[j - 1].duration,
                changed: true,
            });
            i--; j--;
        } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
            result.unshift({
                acceptedImage: accepted[i - 1].name + '.png',
                currentImage: undefined,
                location: accepted[i - 1].source,
                duration: accepted[i - 1].duration,
                changed: true,
            });
            i--;
        } else {
            result.unshift({
                acceptedImage: undefined,
                currentImage: current[j - 1].name + '.png',
                location: current[j - 1].source,
                duration: current[j - 1].duration,
                changed: true,
            });
            j--;
        }
    }

    return result;
}

// ── API handlers ───────────────────────────────────────────────────

interface TestSummary {
    name: string;
    file: string;
    line: number;
    title: string;
    status: string;
    hasChanges: boolean;
}

function getTests(): TestSummary[] {
    if (!fs.existsSync(outputDir)) return [];

    const dirs = fs.readdirSync(outputDir, { withFileTypes: true })
        .filter((d: fs.Dirent) => d.isDirectory())
        .map((d: fs.Dirent) => d.name);

    const tests = dirs.map((name: string) => {
        const manifestPath = path.join(outputDir, name, 'manifest.json');
        let file = name;
        let line = 0;
        let title = name;
        let status = 'unknown';
        let steps: { name: string; source: string }[] = [];

        if (fs.existsSync(manifestPath)) {
            try {
                const manifest: TestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                file = manifest.file;
                line = manifest.line;
                title = manifest.title;
                status = manifest.status;
                steps = manifest.steps;
            } catch { }
        }

        // Check for visual changes
        const expDir = path.join(acceptedDir, name);
        let hasChanges = false;

        if (!fs.existsSync(expDir)) {
            // No expected dir = all images are new
            hasChanges = steps.length > 0;
        } else {
            // Compare current and expected images
            const currentPngs = steps.map(s => s.name);
            const expectedPngs = fs.readdirSync(expDir)
                .filter((f: string) => f.endsWith('.png') && f !== 'error.png')
                .map((f: string) => f.replace('.png', ''))
                .sort();

            if (currentPngs.length !== expectedPngs.length) {
                hasChanges = true;
            } else {
                for (const step of steps) {
                    const currentFile = path.join(outputDir, name, step.name + '.png');
                    const expectedFile = path.join(expDir, step.name + '.png');
                    if (!fs.existsSync(expectedFile)) {
                        hasChanges = true;
                        break;
                    }
                    if (hashFile(currentFile) !== hashFile(expectedFile)) {
                        hasChanges = true;
                        break;
                    }
                }
            }
        }

        return { name, file, line, title, status, hasChanges };
    });

    return tests.sort((a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.name.localeCompare(b.name)
    );
}

function getTestDetails(testName: string): {
    manifest: TestManifest | null;
    steps: AlignedPair[];
} {
    const testDir = path.join(outputDir, testName);
    const manifestPath = path.join(testDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        return { manifest: null, steps: [] };
    }

    const manifest: TestManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const expDir = path.join(acceptedDir, testName);

    // Build current image entries
    const currentEntries: ImageEntry[] = manifest.steps
        .filter(s => fs.existsSync(path.join(testDir, s.name + '.png')))
        .map(s => ({
            name: s.name,
            hash: hashFile(path.join(testDir, s.name + '.png')),
            source: s.source,
            duration: typeof s.duration === 'number' ? s.duration : null,
        }));

    // Build accepted image entries
    let acceptedEntries: ImageEntry[] = [];
    if (fs.existsSync(expDir)) {
        const acceptedManifestPath = path.join(expDir, 'manifest.json');
        if (fs.existsSync(acceptedManifestPath)) {
            try {
                const acceptedManifest: TestManifest = JSON.parse(fs.readFileSync(acceptedManifestPath, 'utf-8'));
                acceptedEntries = acceptedManifest.steps
                    .filter(s => fs.existsSync(path.join(expDir, s.name + '.png')))
                    .map(s => ({
                        name: s.name,
                        hash: hashFile(path.join(expDir, s.name + '.png')),
                        source: s.source,
                        duration: typeof s.duration === 'number' ? s.duration : null,
                    }));
            } catch { }
        } else {
            // No manifest in expected dir — build from files
            acceptedEntries = fs.readdirSync(expDir)
                .filter((f: string) => f.endsWith('.png') && f !== 'error.png')
                .sort()
                .map((f: string) => {
                    const name = f.replace('.png', '');
                    return {
                        name,
                        hash: hashFile(path.join(expDir, f)),
                        source: name,
                        duration: null,
                    };
                });
        }
    }

    const steps = alignImages(acceptedEntries, currentEntries);
    return { manifest, steps };
}

function acceptTest(testName: string): void {
    const testDir = path.join(outputDir, testName);
    const expDir = path.join(acceptedDir, testName);

    if (!fs.existsSync(testDir)) return;

    // Clear existing expected dir
    if (fs.existsSync(expDir)) {
        fs.rmSync(expDir, { recursive: true });
    }
    fs.mkdirSync(expDir, { recursive: true });

    // Copy current PNGs and manifest
    const manifestPath = path.join(testDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
        fs.copyFileSync(manifestPath, path.join(expDir, 'manifest.json'));
    }

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

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

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

    // API routes
    if (pathname === '/api/tests') {
        serveJson(res, getTests());
        return;
    }

    const testDetailMatch = pathname.match(/^\/api\/test\/(.+)/);
    if (testDetailMatch && req.method === 'GET') {
        serveJson(res, getTestDetails(decodeURIComponent(testDetailMatch[1])));
        return;
    }

    const acceptMatch = pathname.match(/^\/api\/accept\/(.+)/);
    if (acceptMatch && req.method === 'POST') {
        acceptTest(decodeURIComponent(acceptMatch[1]));
        serveJson(res, { ok: true });
        return;
    }

    // Serve images from test-results/ and test-accepted/
    const imageMatch = pathname.match(/^\/image\/(current|expected)\/(.+)/);
    if (imageMatch) {
        const baseDir = imageMatch[1] === 'current' ? outputDir : acceptedDir;
        const filePath = path.join(baseDir, imageMatch[2]);
        // Prevent directory traversal
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
});

server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\nshoTest Review: ${url}\n`);

    // Try to open browser
    try {
        const platform = process.platform;
        if (platform === 'linux') execSync(`xdg-open ${url}`, { stdio: 'ignore' });
        else if (platform === 'darwin') execSync(`open ${url}`, { stdio: 'ignore' });
        else if (platform === 'win32') execSync(`start ${url}`, { stdio: 'ignore' });
    } catch { }
});
