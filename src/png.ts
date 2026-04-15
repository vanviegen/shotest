/**
 * Strip non-essential metadata from PNG files to ensure consistent output.
 * Keeps only: IHDR, PLTE, tRNS, IDAT, IEND chunks.
 * Removes: tEXt, iTXt, zTXt, tIME, pHYs, sRGB, gAMA, cHRM, iCCP, etc.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ESSENTIAL_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

export function stripPngMetadata(input: Buffer): Buffer {
    // Verify PNG signature
    if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return input; // Not a PNG, return as-is
    }

    const chunks: Buffer[] = [PNG_SIGNATURE];
    let offset = 8;

    while (offset < input.length) {
        if (offset + 8 > input.length) break;

        const length = input.readUInt32BE(offset);
        const type = input.subarray(offset + 4, offset + 8).toString('ascii');
        const chunkEnd = offset + 12 + length; // 4 (length) + 4 (type) + data + 4 (CRC)

        if (chunkEnd > input.length) break;

        if (ESSENTIAL_CHUNKS.has(type)) {
            chunks.push(input.subarray(offset, chunkEnd));
        }

        offset = chunkEnd;
    }

    return Buffer.concat(chunks);
}
