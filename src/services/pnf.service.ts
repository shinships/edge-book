// PnfService — Point & Figure charting (đồ thị điểm-hình) for VN stocks.
// Pure computation: takes OHLC bars, builds X/O columns with a box size + N-box
// reversal, detects double-top/bottom signals, estimates a vertical-count price
// target, and renders an ASCII grid for Telegram (<pre> monospace). No DB/network.
//
// Method: traditional High/Low, 3-box reversal (default). An X column rises while
// highs make new boxes; it reverses to an O column when the low drops `reversal`
// boxes below the column top (and vice-versa). Box index i covers [i*box,(i+1)*box).

export interface PnfBar { h: number; l: number; c: number; }

export interface PnfColumn {
    dir: 'X' | 'O';
    high: number; // top box index (inclusive)
    low: number;  // bottom box index (inclusive)
}

export type PnfSignal = 'buy' | 'sell' | 'none';

export interface PnfResult {
    box: number;
    reversal: number;
    columns: PnfColumn[];
    signal: PnfSignal;       // most recent completed signal
    signalColIndex: number;  // index into columns where it fired (-1 if none)
    priceTarget?: number;    // vertical-count objective (best-effort)
    lastPrice: number;
}

// Box size scaled to VN price magnitude (prices carried in thousand VND, ~1.2–2.5%/box).
export function defaultBoxSize(price: number): number {
    if (price < 3) return 0.05;
    if (price < 10) return 0.1;
    if (price < 20) return 0.2;
    if (price < 50) return 0.5;
    if (price < 100) return 1;
    if (price < 200) return 2;
    return 5;
}

export class PnfService {
    /**
     * Build P&F columns from oldest→newest bars. Returns null if not enough data
     * or box size is invalid (never throws on normal input).
     */
    compute(bars: PnfBar[], opts?: { box?: number; reversal?: number }): PnfResult | null {
        if (!Array.isArray(bars) || bars.length < 5) return null;
        const lastPrice = bars[bars.length - 1].c;
        let box = defaultBoxSize(lastPrice);
        if (opts?.box && opts.box > 0) {
            let lo = Infinity, hi = -Infinity;
            for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
            const span = (hi - lo) / opts.box;
            // Accept a user-supplied box only if it yields a sensible grid; otherwise keep
            // the auto-scaled default (guards against a 1-cell collapse like box 500 on a
            // 63.5 stock, or a box so tiny it explodes into thousands of rows).
            if (span >= 3 && span <= 500) box = opts.box;
        }
        const reversal = opts?.reversal && opts.reversal >= 1 ? Math.floor(opts.reversal) : 3;
        const idx = (p: number) => Math.floor(p / box + 1e-9);

        const columns: PnfColumn[] = [];
        let cur: PnfColumn | null = null;

        for (const bar of bars) {
            const hi = idx(bar.h);
            const lo = idx(bar.l);
            if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;

            if (!cur) {
                // Seed: first column as X spanning the first bar's range. Over the series
                // the recent (rendered) columns are direction-correct regardless of seed.
                cur = { dir: 'X', high: hi, low: lo };
                columns.push(cur);
                continue;
            }

            if (cur.dir === 'X') {
                if (hi > cur.high) {
                    cur.high = hi; // continuation up
                } else if (lo <= cur.high - reversal) {
                    cur = { dir: 'O', high: cur.high - 1, low: lo }; // reverse down
                    columns.push(cur);
                }
            } else {
                if (lo < cur.low) {
                    cur.low = lo; // continuation down
                } else if (hi >= cur.low + reversal) {
                    cur = { dir: 'X', high: hi, low: cur.low + 1 }; // reverse up
                    columns.push(cur);
                }
            }
        }

        if (columns.length === 0) return null;

        // Signal: double-top buy (X high > X two columns back) / double-bottom sell.
        let signal: PnfSignal = 'none';
        let signalColIndex = -1;
        for (let i = 2; i < columns.length; i++) {
            const c = columns[i];
            const p = columns[i - 2];
            if (c.dir === 'X' && p.dir === 'X' && c.high > p.high) { signal = 'buy'; signalColIndex = i; }
            else if (c.dir === 'O' && p.dir === 'O' && c.low < p.low) { signal = 'sell'; signalColIndex = i; }
        }

        // Vertical-count price objective from the signal column (best-effort, rounded to box).
        let priceTarget: number | undefined;
        if (signalColIndex >= 0) {
            const col = columns[signalColIndex];
            const boxes = col.high - col.low + 1;
            priceTarget = signal === 'buy'
                ? col.low * box + boxes * reversal * box
                : col.high * box - boxes * reversal * box;
            if (priceTarget < 0) priceTarget = undefined;
        }

        return { box, reversal, columns, signal, signalColIndex, priceTarget, lastPrice };
    }

    /**
     * Render the last `maxCols` columns as an ASCII grid (rows = price boxes, high→low).
     * Returns a monospace block (no markup) suitable for wrapping in Telegram <pre>.
     */
    render(result: PnfResult, maxCols = 14, maxRows = 26): string {
        const cols = result.columns.slice(-maxCols);
        if (cols.length === 0) return '(không đủ dữ liệu)';

        let maxIdx = -Infinity;
        let minIdx = Infinity;
        for (const c of cols) { maxIdx = Math.max(maxIdx, c.high); minIdx = Math.min(minIdx, c.low); }
        if (maxIdx - minIdx + 1 > maxRows) minIdx = maxIdx - maxRows + 1; // keep the top rows

        const dec = result.box < 1 ? (result.box < 0.1 ? 2 : 1) : 0;
        const lines: string[] = [];
        for (let r = maxIdx; r >= minIdx; r--) {
            let row = '';
            for (const c of cols) {
                row += (r <= c.high && r >= c.low) ? c.dir : ' ';
            }
            const price = (r * result.box).toFixed(dec).padStart(7);
            lines.push(`${price} |${row}`);
        }
        return lines.join('\n');
    }
}
