/**
 * Lossless WebP compression for accepted baselines.
 *
 * Test runs keep writing PNGs: Playwright emits those natively, so capture stays
 * as cheap as it can be. Accepted baselines are a different trade-off — they get
 * committed to version control and rewritten rarely, so it pays to spend real CPU
 * on them once. libwebp's slowest lossless setting roughly halves the size of a
 * typical UI screenshot, pixel for pixel identical.
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

/**
 * Rewrite every PNG in `dir` as a lossless WebP, dropping the PNG once its WebP
 * replacement is on disk. Runs in the background, so `isCancelled` is checked
 * before each write: a newer accept for the same directory wins.
 */
export async function compressDirectoryToWebp(dir: string, isCancelled: () => boolean = () => false): Promise<void> {
    let pngFiles: string[];
    try {
        pngFiles = fs.readdirSync(dir).filter((file) => file.endsWith('.png'));
    } catch {
        return;
    }
    for (const file of pngFiles) {
        if (isCancelled()) return;

        const pngPath = path.join(dir, file);
        const webpPath = pngPath.slice(0, -'.png'.length) + '.webp';

        try {
            const stat = fs.statSync(pngPath);
            // In lossless mode `quality` is not image quality but how hard libwebp
            // searches for a smaller encoding: 100 costs ~5x the CPU of the default
            // and buys ~20 percentage points of file size. Worth it, once, here.
            const webp = await sharp(pngPath).webp({ lossless: true, quality: 100, effort: 6 }).toBuffer();
            if (isCancelled()) return;

            // Never trade a smaller file for a bigger one; both formats are read
            // back just fine, so keeping the PNG is a valid outcome.
            if (webp.length >= stat.size) continue;

            fs.writeFileSync(webpPath, webp);
            fs.rmSync(pngPath, { force: true });
        } catch (error) {
            console.warn(`ShoTest: could not convert ${pngPath} to WebP: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
