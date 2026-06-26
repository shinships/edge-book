// Renders a PnfResult to a PNG buffer (Telegram photo) using @napi-rs/canvas.
// Kept separate from pnf.service.ts so the P&F math stays dependency-free.
//
// FONT-FREE BY DESIGN: @napi-rs/canvas has no font registered in a bare Linux
// container (Railway) → fillText would render tofu boxes. So everything is drawn as
// vectors: X = two diagonal strokes, O = a ring, and price-axis numbers use a tiny
// 7-segment digit renderer. Title/signal/legend live in the Telegram caption.

import { createCanvas, SKRSContext2D } from '@napi-rs/canvas';
import { PnfResult } from './pnf.service';

const COL = {
    bg: '#0e1621',
    grid: '#1c2733',
    axis: '#8b98a5',
    x: '#2ec47e', // green = demand/up
    o: '#f0616d', // red = supply/down
};

// 7-segment glyph table: which of segments a,b,c,d,e,f,g are lit per char.
const SEG: Record<string, string> = {
    '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
    '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};

// Draw a single 7-segment char at top-left (x,y), size w×h. '.' draws a dot.
function drawSegChar(ctx: SKRSContext2D, ch: string, x: number, y: number, w: number, h: number): void {
    if (ch === '.') {
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.beginPath();
        ctx.arc(x + 1.2, y + h, 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    const segs = SEG[ch];
    if (!segs) return;
    const m = h / 2;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
        ctx.beginPath();
        ctx.moveTo(x + x1, y + y1);
        ctx.lineTo(x + x2, y + y2);
        ctx.stroke();
    };
    if (segs.includes('a')) line(0, 0, w, 0);
    if (segs.includes('b')) line(w, 0, w, m);
    if (segs.includes('c')) line(w, m, w, h);
    if (segs.includes('d')) line(0, h, w, h);
    if (segs.includes('e')) line(0, m, 0, h);
    if (segs.includes('f')) line(0, 0, 0, m);
    if (segs.includes('g')) line(0, m, w, m);
}

// Width a number string occupies with the given digit width + spacing.
function segWidth(s: string, dw: number, gap: number): number {
    let w = 0;
    for (const ch of s) w += (ch === '.' ? 3 : dw) + (ch === '.' ? gap * 0.5 : gap);
    return w - gap;
}

// Draw a right-aligned number ending at xRight, vertically centered on yMid.
function drawSegNumber(ctx: SKRSContext2D, s: string, xRight: number, yMid: number): void {
    const dh = 11, dw = 6, gap = 3.5;
    let x = xRight - segWidth(s, dw, gap);
    const y = yMid - dh / 2;
    for (const ch of s) {
        drawSegChar(ctx, ch, x, y, dw, dh);
        x += (ch === '.' ? 3 : dw) + (ch === '.' ? gap * 0.5 : gap);
    }
}

/**
 * Draw the last `maxCols` P&F columns as a dark "terminal" grid PNG.
 */
export function renderPnfImage(result: PnfResult, _ticker: string, maxCols = 28, maxRows = 36): Buffer {
    const cols = result.columns.slice(-maxCols);
    let maxIdx = -Infinity;
    let minIdx = Infinity;
    for (const c of cols) { maxIdx = Math.max(maxIdx, c.high); minIdx = Math.min(minIdx, c.low); }
    if (!Number.isFinite(maxIdx)) { maxIdx = 0; minIdx = 0; }
    if (maxIdx - minIdx + 1 > maxRows) minIdx = maxIdx - maxRows + 1;
    const rows = maxIdx - minIdx + 1;

    const CELL = 22;
    const padL = 58;
    const padR = 16;
    const padT = 16;
    const padB = 16;
    const W = padL + cols.length * CELL + padR;
    const H = padT + rows * CELL + padB;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    const dec = result.box < 1 ? (result.box < 0.1 ? 2 : 1) : 0;
    const yOf = (idx: number) => padT + (maxIdx - idx) * CELL + CELL / 2;

    // Horizontal gridlines + 7-segment price axis (about every Nth box)
    const step = Math.max(1, Math.ceil(rows / 16));
    for (let r = maxIdx; r >= minIdx; r--) {
        if ((maxIdx - r) % step !== 0) continue;
        const y = yOf(r);
        ctx.strokeStyle = COL.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();
        ctx.strokeStyle = COL.axis;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        drawSegNumber(ctx, (r * result.box).toFixed(dec), padL - 8, y);
    }

    // Column marks: X = two diagonal strokes (green), O = ring (red)
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    const rad = CELL * 0.3;
    cols.forEach((c, j) => {
        const cx = padL + j * CELL + CELL / 2;
        ctx.strokeStyle = c.dir === 'X' ? COL.x : COL.o;
        for (let r = c.low; r <= c.high; r++) {
            if (r > maxIdx || r < minIdx) continue;
            const cy = yOf(r);
            if (c.dir === 'X') {
                ctx.beginPath();
                ctx.moveTo(cx - rad, cy - rad);
                ctx.lineTo(cx + rad, cy + rad);
                ctx.moveTo(cx - rad, cy + rad);
                ctx.lineTo(cx + rad, cy - rad);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(cx, cy, rad, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    });

    return canvas.toBuffer('image/png');
}
