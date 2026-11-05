/**
 * Lossless WebP compression for screenshots on their way into the accepted
 * baseline pool.
 *
 * Test runs keep writing PNGs: Playwright emits those natively, so capture stays
 * as cheap as it can be. Accepted baselines are a different trade-off — they get
 * committed to version control and rewritten rarely, so it pays to spend real CPU
 * on them once. libwebp's slowest lossless setting roughly halves the size of a
 * typical UI screenshot, pixel for pixel identical.
 *
 * The review app converts a test's images in test-results/ as soon as the
 * test is marked accepted, so that applying the review has little left to
 * wait for: up to 8 images at a time, one CPU core each. Pool files are
 * immutable (their name is a hash of their pixels, and lossless
 * recompression preserves those), so a conversion is never undone or
 * cancelled, merely not waited for.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { progressAdd, progressDone, progressStop } from './progress.js';

// One core per concurrent encode; concurrency provides the parallelism.
sharp.concurrency(1);

const maxRunning = Math.min(8, os.availableParallelism?.() ?? os.cpus().length);
let running = 0;
const waiting: Array<() => void> = [];

// Every conversion ever started, by PNG path: asking again for one that ran
// (or is running) waits for that one.
const conversions = new Map<string, Promise<void>>();

/** How far the conversions started so far have got. */
export const conversionProgress = { done: 0, total: 0 };

/**
 * Compress the PNGs of the given hashes in `dir` to lossless WebP, deleting
 * each PNG once its replacement is on disk. Resolves when all of them are
 * done; hashes without a PNG (already converted) are done right away.
 */
export function compressImages(dir: string, hashes: Iterable<string>): Promise<void> {
    return Promise.all([...hashes].map((hash) => {
        const pngPath = path.resolve(dir, hash + '.png');
        let conversion = conversions.get(pngPath);
        if (!conversion) {
            conversionProgress.total++;
            progressAdd('ShoTest: converting screenshots to WebP', 1);
            conversion = withSlot(() => compressFile(pngPath)).then(() => {
                progressDone();
                if (++conversionProgress.done === conversionProgress.total) progressStop();
            });
            conversions.set(pngPath, conversion);
        }
        return conversion;
    })).then(() => { });
}

async function withSlot(fn: () => Promise<void>): Promise<void> {
    while (running >= maxRunning) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
        await fn();
    } finally {
        running--;
        waiting.shift()?.();
    }
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
        if (webp.length >= stat.size) return;

        // The review server reads the pool while the conversion runs, so the
        // WebP appears under its real name only once it is complete: a
        // half-written file is a broken image in the browser.
        fs.writeFileSync(partialPath, webp);
        fs.renameSync(partialPath, webpPath);
        fs.rmSync(pngPath, { force: true });
    } catch (error) {
        fs.rmSync(partialPath, { force: true });
        // A PNG that is not there (converted before, or removed by gc) is
        // expected, not worth a warning.
        if (fs.existsSync(pngPath)) {
            console.warn(`ShoTest: could not convert ${pngPath} to WebP: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
