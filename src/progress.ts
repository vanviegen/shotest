/**
 * A one-line console progress bar for slow background work.
 *
 * Only drawn on an interactive terminal: a line redrawn with carriage returns
 * is unreadable noise in a log file or CI output, so with a non-TTY stderr
 * every function here is a no-op.
 *
 * While a bar is on screen, writes to stdout and stderr are wrapped, so that
 * anything else printed — a warning, the review server's URL — erases the bar
 * before it lands and the bar redraws below it, instead of the two colliding
 * on one line. Only one bar exists at a time; a second job would just
 * overwrite the first one's line anyway.
 */

const BAR_WIDTH = 24;

let label = '';
let total = 0;
let done = 0;

// Bound stderr.write from before the wrapping below, so drawing the bar does
// not recurse back into it. Undefined exactly when no bar is active.
let barWrite: ((text: string) => void) | undefined;
let originalWrites: Array<[NodeJS.WriteStream, NodeJS.WriteStream['write']]> = [];

let drawn = false;      // the bar currently occupies the cursor's line
let atLineStart = true; // ...and it may be drawn: no half-written foreign line is in the way
let exitHooked = false;

/**
 * Add `count` units of work, drawing the bar if it is not up yet. Extending a
 * running bar keeps the work already counted, so a job that discovers more to
 * do halfway through does not restart at zero.
 */
export function progressAdd(text: string, count: number): void {
    if (count <= 0) return;
    total += count;
    label = text;
    if (!barWrite) start();
    render();
}

/** Mark one unit of work finished. */
export function progressDone(): void {
    done++;
    render();
}

/** Take the bar off screen and forget the job it was tracking. */
export function progressStop(): void {
    erase();
    for (const [stream, write] of originalWrites) stream.write = write;
    originalWrites = [];
    barWrite = undefined;
    label = '';
    total = 0;
    done = 0;
}

function start(): void {
    if (!process.stderr.isTTY) return;
    barWrite = process.stderr.write.bind(process.stderr);
    atLineStart = true;

    for (const stream of [process.stdout, process.stderr]) {
        // A stream that is not this terminal (piped to a file, say) cannot
        // scribble over the bar, and must not have escape codes aimed at it.
        if (!stream.isTTY) continue;
        const original = stream.write.bind(stream);
        originalWrites.push([stream, stream.write]);
        stream.write = ((chunk: any, encoding?: any, callback?: any) => {
            erase();
            if (chunk?.length) atLineStart = endsWithNewline(chunk);
            const result = original(chunk, encoding, callback);
            render();
            return result;
        }) as NodeJS.WriteStream['write'];
    }

    // An uncaught error or an explicit exit should not leave half a bar above
    // the shell prompt. A signal still can: Node skips 'exit' handlers there.
    if (!exitHooked) {
        exitHooked = true;
        process.on('exit', erase);
    }
}

function render(): void {
    // Mid-line foreign output: wait for its newline rather than tack the bar
    // onto the end of it.
    if (!barWrite || !atLineStart) return;

    // Leave the last column free: writing into it wraps to the next line on
    // most terminals, which would scroll a fresh bar into view on every redraw.
    const width = (process.stderr.columns || 80) - 1;
    const counts = ` ${done}/${total}`;
    const barWidth = Math.min(BAR_WIDTH, width - label.length - 1 - counts.length);

    // A narrow terminal loses the bar before it loses the numbers, which are
    // the part that actually says how far along the job is.
    let line: string;
    if (barWidth >= 4) {
        const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
        line = `${label} ${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}${counts}`;
    } else {
        line = (label + counts).slice(-width);
    }

    barWrite('\r\x1b[K' + line.slice(0, width));
    drawn = true;
}

function erase(): void {
    if (!drawn || !barWrite) return;
    barWrite('\r\x1b[K');
    drawn = false;
}

function endsWithNewline(chunk: string | Uint8Array): boolean {
    if (typeof chunk === 'string') return chunk.endsWith('\n');
    if (chunk instanceof Uint8Array) return chunk[chunk.length - 1] === 0x0a;
    return true;
}
