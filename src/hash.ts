/**
 * Content-addressed screenshot names.
 *
 * A screenshot is named by a hash of its decoded pixels (plus dimensions), not
 * of its encoded bytes. That keeps the name stable across encoders: the PNG a
 * test writes and the lossless WebP a baseline is later recompressed to carry
 * the same pixels, so they carry the same name. It also dedupes: two steps —
 * or two tests — that produce identical frames share a single pool file.
 *
 * 16 hex chars = 64 bits. Screenshot pools count in the thousands, where the
 * birthday bound puts an accidental collision around 1 in 10^12 — and a
 * collision would only merge two frames that were then reviewed as one.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const IMAGE_HASH_LENGTH = 16;

/** Matches pool files derived from an image hash (images and HTML snapshots). */
export const POOL_FILE_RE = /^([0-9a-f]{16})\.(png|webp|body\.html|head\.html)$/;

export async function hashImagePixels(encoded: Buffer): Promise<string> {
    const { data, info } = await sharp(encoded).raw().toBuffer({ resolveWithObject: true });
    return createHash('sha256')
        .update(`${info.width}x${info.height}:`)
        .update(data)
        .digest('hex')
        .slice(0, IMAGE_HASH_LENGTH);
}

/**
 * Where two same-sized images differ: the bounding box of the differing
 * pixels (in image pixels, with the image width for scaling), `false` when
 * they are identical, `null` when their dimensions differ.
 */
export async function diffImageBox(a: Buffer, b: Buffer): Promise<{ x: number; y: number; width: number; height: number; imageWidth: number } | false | null> {
    const [ia, ib] = await Promise.all([a, b].map((buf) => sharp(buf).raw().toBuffer({ resolveWithObject: true })));
    if (ia.info.width !== ib.info.width || ia.info.height !== ib.info.height || ia.info.channels !== ib.info.channels) return null;
    const { width, height, channels } = ia.info;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width * channels;
        for (let x = 0; x < width; x++) {
            const offset = row + x * channels;
            for (let c = 0; c < channels; c++) {
                if (ia.data[offset + c] !== ib.data[offset + c]) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    break;
                }
            }
        }
    }
    if (maxX < 0) return false;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, imageWidth: width };
}
