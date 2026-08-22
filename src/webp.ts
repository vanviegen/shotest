/**
 * Lossless WebP compression for the accepted baseline pool.
 *
 * Test runs keep writing PNGs: Playwright emits those natively, so capture stays
 * as cheap as it can be. Accepted baselines are a different trade-off — they get
 * committed to version control and rewritten rarely, so it pays to spend real CPU
 * on them once. libwebp's slowest lossless setting roughly halves the size of a
 * typical UI screenshot, pixel for pixel identical.
 *
 * Baselines are content-addressed pool files shared by many tests, so
 * compression runs as one central background job over the whole pool: up to
 * 8 images at a time, one CPU core each. Pool files are immutable (their name
 * is a hash of their pixels, and lossless recompression preserves those), so
 * there is nothing to cancel — a file deleted by gc mid-conversion at worst
 * leaves a stray WebP for the next gc to sweep up.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { POOL_FILE_RE } from './hash.js';
import { progressAdd, progressDone, progressStop } from './progress.js';

// One core per concurrent encode; concurrency provides the parallelism.
sharp.concurrency(1);

const MAX_CORES = 8;

// PNGs that came out smaller than their WebP encoding — no point re-encoding
// them on every pass for the lifetime of this process.
const keepAsPng = new Set<string>();

let running = false;
let rescanRequested = false;

/**
 * Compress every hash-named PNG in the accepted pool to lossless WebP,
 * deleting the PNG once its replacement is on disk. Runs in the background;
 * calling it while a pass is active schedules a rescan after that pass, so
 * images from a fresh accept are always picked up.
 */
export async function compressAcceptedPool(dir: string): Promise<void> {
    // Callers pass both relative and absolute paths; keepAsPng keys on the
    // full path, so normalize before anything is recorded under it.
    dir = path.resolve(dir);
    if (running) {
        rescanRequested = true;
        return;
    }
    running = true;
    try {
        do {
            rescanRequested = false;
            await compressOnce(dir);
        } while (rescanRequested);
    } finally {
        running = false;
        progressStop();
    }
}

async function compressOnce(dir: string): Promise<void> {
    let pngFiles: string[];
    try {
        pngFiles = fs.readdirSync(dir).filter((file) => {
            const match = POOL_FILE_RE.exec(file);
            return match?.[2] === 'png' && !keepAsPng.has(path.join(dir, file));
        });
    } catch {
        return;
    }

    // Encoding a full pool takes a while and produces no output of its own;
    // the bar spans every pass, so a rescan extends it instead of restarting it.
    progressAdd('ShoTest: converting baselines to WebP', pngFiles.length);

    const queue = [...pngFiles];
    const workerCount = Math.min(MAX_CORES, os.availableParallelism?.() ?? os.cpus().length, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
            await compressFile(path.join(dir, file));
            progressDone();
        }
    }));
}

async function compressFile(pngPath: string): Promise<void> {
    const webpPath = pngPath.slice(0, -'.png'.length) + '.webp';
    const partialPath = webpPath + '.partial';

    try {
        const stat = fs.statSync(pngPath);
        // In lossless mode `quality` is not image quality but how hard libwebp
        // searches for a smaller encoding: 100 costs ~5x the CPU of the default
        // and buys ~20 percentage points of file size. Worth it, once, here.
        const webp = await sharp(pngPath).webp({ lossless: true, quality: 100, effort: 6 }).toBuffer();

        // Never trade a smaller file for a bigger one; both formats are read
        // back just fine, so keeping the PNG is a valid outcome.
        if (webp.length >= stat.size) {
            keepAsPng.add(pngPath);
            return;
        }

        // The review server reads the pool while the conversion runs, so the
        // WebP appears under its real name only once it is complete: a
        // half-written file is a broken image in the browser and a comparison
        // failure — which the summary reports as a visual change — in the server.
        fs.writeFileSync(partialPath, webp);
        fs.renameSync(partialPath, webpPath);
        fs.rmSync(pngPath, { force: true });
    } catch (error) {
        fs.rmSync(partialPath, { force: true });
        // A PNG that gc removed mid-conversion is expected, not worth a warning.
        if (fs.existsSync(pngPath)) {
            console.warn(`ShoTest: could not convert ${pngPath} to WebP: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
