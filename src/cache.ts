/**
 * The result cache: what a test that passed looked like, by the source tree
 * it ran on. A test with a result for the tree a run is on need not run
 * again — nothing it depends on changed — so its result is taken from here
 * instead. The cache lives outside the project, so that every checkout of it
 * (a git worktree, another clone, a container with the directory mounted)
 * shares it, and running tests never writes to files git tracks.
 *
 *   <cache>/<tree>-<renderer>/<test-base>.json   a test's result
 *   <cache>/<hash>.png                           the screenshots of them all
 *
 * The renderer (the Playwright container image, or the native Playwright
 * version) is part of the key: a screenshot is only as reproducible as what
 * rendered it. Whether a result still matches its baseline is not: that is
 * decided where the result is used, against that checkout's baselines.
 *
 * Whatever was not used for a month is removed (see pruneCache), so files are
 * touched when used.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { POOL_FILE_RE } from './hash.js';
import { findTestRecord, isGapStep, writeTestRecord, type TestIdentity, type TestRecord } from './manifest.js';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The cache directory: SHOTEST_CACHE_DIR, or shotest/ in the user's cache directory. */
export function cacheDir(): string {
    return path.resolve(process.env.SHOTEST_CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'shotest'));
}

/** The directory in `cache` of the results on a source tree, as rendered by `renderer`. */
export function cacheResultsDir(cache: string, tree: string, renderer: string): string {
    return path.join(cache, `${tree}-${renderer.replace(/[^A-Za-z0-9.]+/g, '-')}`);
}

function touch(file: string): void {
    const now = new Date();
    try {
        fs.utimesSync(file, now, now);
    } catch { } // not there (any more)
}

/**
 * Copy a result — its record into `toDir`, its screenshots from one pool to
 * the other — unless a screenshot is missing. Safe across Playwright's
 * worker processes, and across runs sharing the cache.
 */
function copyResult(record: TestRecord, fromPool: string, toPool: string, toDir: string): boolean {
    fs.mkdirSync(toDir, { recursive: true });
    for (const step of record.steps) {
        if (isGapStep(step)) continue;
        const from = path.join(fromPool, step.image + '.png');
        const to = path.join(toPool, step.image + '.png');
        if (!fs.existsSync(to)) {
            if (!fs.existsSync(from)) return false;
            // Copy-then-rename: nobody sees a half-written screenshot.
            const tmp = `${to}.tmp${process.pid}`;
            fs.copyFileSync(from, tmp, fs.constants.COPYFILE_FICLONE);
            fs.renameSync(tmp, to);
        }
        touch(from);
        touch(to);
    }
    writeTestRecord(toDir, record);
    return true;
}

/** Keep the result of a test that passed, for the runs to come on its tree. */
export function storeResult(record: TestRecord, resultsDir: string, cacheResults: string): void {
    copyResult(record, resultsDir, path.dirname(cacheResults), cacheResults);
}

/** Put the cached result of a test into `resultsDir`; false when there is none. */
export function restoreResult(test: TestIdentity, cacheResults: string, resultsDir: string): boolean {
    const record = findTestRecord(cacheResults, test);
    if (!record || !copyResult(record, path.dirname(cacheResults), resultsDir, resultsDir)) return false;
    touch(cacheResults);
    return true;
}

/** Remove the results and screenshots that went unused for a month. */
export function pruneCache(cache: string): void {
    for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
        // Only what the cache itself puts there, should the directory be shared.
        if (!POOL_FILE_RE.test(entry) && !/^[0-9a-f]{40,64}-/.test(entry)) continue;
        const file = path.join(cache, entry);
        try {
            if (Date.now() - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { recursive: true, force: true });
        } catch { } // gone already: another run pruned it
    }
}
