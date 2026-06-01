import PDFDocument from 'pdfkit';
import { TradeItem, TradeStats, TradeAnalytics } from './trade.service';

// PDF content uses ASCII/English labels because pdfkit's built-in fonts
// (Helvetica, WinAnsi) cannot render Vietnamese diacritics. Bot chat stays VN.

export interface TradeReportData {
    traderName: string;        // display name (sanitized to ASCII by caller if needed)
    generatedAt: Date;
    stats: TradeStats;
    analytics: TradeAnalytics;
    closedTrades: TradeItem[];  // closed trades, newest-first preferred
}

// --- Layout constants ---
const PAGE_MARGIN = 50;
const COLORS = {
    text: '#1f2937',
    muted: '#6b7280',
    line: '#d1d5db',
    green: '#16a34a',
    red: '#dc2626',
    headerBg: '#111827',
    accent: '#2563eb',
};

export class ReportService {
    /**
     * Build a trade performance report PDF and return it as a Buffer.
     */
    generateTradeReport(data: TradeReportData): Promise<Buffer> {
        // bufferPages keeps pages in memory so the footer pass can switchToPage()
        // back to earlier pages — without it, multi-page reports throw.
        const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        const done = new Promise<Buffer>((resolve, reject) => {
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
        });

        const left = PAGE_MARGIN;
        const right = doc.page.width - PAGE_MARGIN;
        const contentWidth = right - left;

        // --- Header banner ---
        doc.rect(0, 0, doc.page.width, 90).fill(COLORS.headerBg);
        doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
            .text('EdgeBook', left, 26);
        doc.fontSize(12).font('Helvetica')
            .text('Trade Performance Report', left, 54);
        doc.fontSize(9).fillColor('#9ca3af')
            .text(
                `${data.traderName}  •  Generated ${this.fmtDate(data.generatedAt)}`,
                left, 70
            );

        doc.fillColor(COLORS.text);
        let y = 115;

        // --- Summary ---
        y = this.sectionTitle(doc, 'Summary', left, y);
        const s = data.stats;
        const summaryRows: [string, string][] = [
            ['Total trades', `${s.total}  (open ${s.open}, closed ${s.closed})`],
            ['Win rate', `${s.winRate}%  (${s.wins}W / ${s.losses}L)`],
            ['Total PnL', this.fmtPct(s.totalPnl)],
            ['Avg planned RR', `${s.avgRR}`],
        ];
        if (data.analytics.avgHoldHours !== null) {
            summaryRows.push(['Avg hold time', this.fmtHold(data.analytics.avgHoldHours)]);
        }
        if (s.best) summaryRows.push(['Best trade', `${s.best.ticker} ${this.fmtPct(s.best.pnlPercent ?? 0)}`]);
        if (s.worst) summaryRows.push(['Worst trade', `${s.worst.ticker} ${this.fmtPct(s.worst.pnlPercent ?? 0)}`]);
        y = this.keyValueBlock(doc, summaryRows, left, y, contentWidth);
        y += 14;

        // --- Monthly PnL chart ---
        if (data.analytics.byMonth.length > 0) {
            y = this.sectionTitle(doc, 'Monthly PnL (%)', left, y);
            y = this.barChart(
                doc,
                data.analytics.byMonth.map((m) => ({ label: m.month, value: m.totalPnl })),
                left, y, contentWidth, 130
            );
            y += 16;
        }

        // --- By ticker table ---
        if (data.analytics.byTicker.length > 0) {
            y = this.ensureSpace(doc, y, 120);
            y = this.sectionTitle(doc, 'By Ticker', left, y);
            y = this.table(
                doc,
                ['Ticker', 'Trades', 'Win%', 'Total PnL', 'Avg PnL'],
                data.analytics.byTicker.slice(0, 15).map((t) => [
                    t.ticker, `${t.trades}`, `${t.winRate}`,
                    this.fmtPct(t.totalPnl), this.fmtPct(t.avgPnl),
                ]),
                left, y, contentWidth,
                [0.34, 0.14, 0.14, 0.19, 0.19],
                (row) => this.pnlColor(parseFloat(row[3])),
            );
            y += 16;
        }

        // --- By direction ---
        if (data.analytics.byDirection.length > 0) {
            y = this.ensureSpace(doc, y, 100);
            y = this.sectionTitle(doc, 'By Direction', left, y);
            y = this.table(
                doc,
                ['Direction', 'Trades', 'Win%', 'Total PnL'],
                data.analytics.byDirection.map((d) => [
                    d.direction.toUpperCase(), `${d.trades}`, `${d.winRate}`, this.fmtPct(d.totalPnl),
                ]),
                left, y, contentWidth,
                [0.34, 0.22, 0.22, 0.22],
                (row) => this.pnlColor(parseFloat(row[3])),
            );
            y += 16;
        }

        // --- Closed trades log (all of them — the table paginates as needed) ---
        if (data.closedTrades.length > 0) {
            y = this.ensureSpace(doc, y, 120);
            y = this.sectionTitle(doc, `Closed Trades (${data.closedTrades.length})`, left, y);
            y = this.table(
                doc,
                ['Date', 'Dir', 'Ticker', 'Entry', 'Exit', 'PnL'],
                data.closedTrades.map((t) => [
                    this.fmtShortDate(t.closedAt ?? t.openedAt),
                    t.direction.toUpperCase(),
                    t.ticker,
                    this.fmtNum(t.entryPrice),
                    t.exitPrice !== undefined ? this.fmtNum(t.exitPrice) : '-',
                    this.fmtPct(t.pnlPercent ?? 0),
                ]),
                left, y, contentWidth,
                [0.18, 0.12, 0.2, 0.17, 0.17, 0.16],
                (row) => this.pnlColor(parseFloat(row[5])),
            );
        }

        // --- Footer on every page ---
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica')
                .text(
                    `EdgeBook · capture your edge.   Page ${i - range.start + 1} of ${range.count}`,
                    left, doc.page.height - 35, { width: contentWidth, align: 'center' }
                );
        }

        doc.end();
        return done;
    }

    // --- Drawing helpers ---

    private sectionTitle(doc: PDFKit.PDFDocument, title: string, x: number, y: number): number {
        doc.fillColor(COLORS.accent).fontSize(13).font('Helvetica-Bold').text(title, x, y);
        const ny = y + 18;
        doc.moveTo(x, ny).lineTo(doc.page.width - PAGE_MARGIN, ny).lineWidth(1).strokeColor(COLORS.line).stroke();
        doc.fillColor(COLORS.text);
        return ny + 8;
    }

    private keyValueBlock(
        doc: PDFKit.PDFDocument, rows: [string, string][], x: number, y: number, width: number
    ): number {
        doc.fontSize(10);
        const rowH = 18;
        const labelW = width * 0.4;
        rows.forEach((r, i) => {
            const ry = y + i * rowH;
            doc.font('Helvetica').fillColor(COLORS.muted).text(r[0], x, ry, { width: labelW });
            doc.font('Helvetica-Bold').fillColor(COLORS.text).text(r[1], x + labelW, ry, { width: width - labelW });
        });
        return y + rows.length * rowH;
    }

    private table(
        doc: PDFKit.PDFDocument,
        headers: string[],
        rows: string[][],
        x: number, y: number, width: number,
        colFractions: number[],
        rowColor?: (row: string[]) => string,
    ): number {
        const rowH = 18;
        const colX = colFractions.reduce<number[]>((acc, f, i) => {
            acc.push(i === 0 ? x : acc[i - 1] + colFractions[i - 1] * width);
            return acc;
        }, []);
        const colW = colFractions.map((f) => f * width);

        // Draw the header row at a given y and return the y for the first data row.
        const drawHeader = (hy: number): number => {
            doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted);
            headers.forEach((h, i) => {
                doc.text(h, colX[i], hy, { width: colW[i], align: i === 0 ? 'left' : 'right' });
            });
            const ny = hy + rowH;
            doc.moveTo(x, ny - 4).lineTo(x + width, ny - 4).lineWidth(0.5).strokeColor(COLORS.line).stroke();
            doc.font('Helvetica').fontSize(9);
            return ny;
        };

        let ry = drawHeader(y);

        // Data rows — repeat the header whenever a page break occurs.
        for (const row of rows) {
            const beforeY = ry;
            ry = this.ensureSpace(doc, ry, rowH + 4);
            if (ry < beforeY) ry = drawHeader(ry); // new page → redraw header
            row.forEach((cell, i) => {
                // Color only the PnL-ish last column; keep the rest neutral.
                const isLast = i === row.length - 1;
                doc.fillColor(isLast && rowColor ? rowColor(row) : COLORS.text);
                doc.text(cell, colX[i], ry, { width: colW[i], align: i === 0 ? 'left' : 'right' });
            });
            ry += rowH;
        }
        doc.fillColor(COLORS.text);
        return ry;
    }

    /**
     * Simple vertical bar chart around a zero baseline. Green up, red down.
     */
    private barChart(
        doc: PDFKit.PDFDocument,
        points: { label: string; value: number }[],
        x: number, y: number, width: number, height: number
    ): number {
        const maxAbs = Math.max(1, ...points.map((p) => Math.abs(p.value)));
        const baseline = y + height / 2;
        const n = points.length;
        const slot = width / n;
        const barW = Math.min(40, slot * 0.5);
        const halfH = height / 2 - 14; // leave room for labels

        // baseline
        doc.moveTo(x, baseline).lineTo(x + width, baseline).lineWidth(0.5).strokeColor(COLORS.line).stroke();

        doc.fontSize(7).font('Helvetica');
        points.forEach((p, i) => {
            const cx = x + slot * i + slot / 2;
            const h = (Math.abs(p.value) / maxAbs) * halfH;
            const up = p.value >= 0;
            const barY = up ? baseline - h : baseline;
            doc.rect(cx - barW / 2, barY, barW, h).fill(up ? COLORS.green : COLORS.red);
            // value label
            doc.fillColor(up ? COLORS.green : COLORS.red)
                .text(this.fmtPct(p.value), cx - slot / 2, up ? barY - 10 : barY + h + 2, {
                    width: slot, align: 'center',
                });
            // month label
            doc.fillColor(COLORS.muted)
                .text(p.label, cx - slot / 2, y + height - 2, { width: slot, align: 'center' });
        });
        doc.fillColor(COLORS.text);
        return y + height + 6;
    }

    /** Add a new page if there isn't enough vertical space; return updated y. */
    private ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
        const bottom = doc.page.height - PAGE_MARGIN - 25; // keep room for footer
        if (y + needed > bottom) {
            doc.addPage();
            return PAGE_MARGIN;
        }
        return y;
    }

    // --- Formatting helpers ---

    private fmtPct(n: number): string {
        return `${n > 0 ? '+' : ''}${n}%`;
    }

    private pnlColor(n: number): string {
        return n > 0 ? COLORS.green : n < 0 ? COLORS.red : COLORS.text;
    }

    private fmtNum(v: number): string {
        if (v >= 1000) {
            const k = v / 1000;
            return `${Number.isInteger(k) ? k : k.toFixed(2).replace(/\.?0+$/, '')}k`;
        }
        return `${v}`;
    }

    private fmtHold(hours: number): string {
        const totalMinutes = Math.round(hours * 60);
        if (totalMinutes < 60) return `${totalMinutes}m`;
        const totalHours = totalMinutes / 60;
        if (totalHours < 24) {
            const h = Math.round(totalHours * 10) / 10;
            if (h < 24) return `${h}h`;
        }
        const days = Math.floor(totalMinutes / 1440);
        const remHours = Math.round((totalMinutes % 1440) / 60);
        if (remHours === 24) return `${days + 1}d`;
        return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
    }

    private fmtDate(d: Date): string {
        return d.toISOString().slice(0, 10);
    }

    private fmtShortDate(iso: string): string {
        return iso.slice(0, 10);
    }
}
