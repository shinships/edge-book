// VnStockService — live Vietnamese stock data via VNDirect public APIs (no key).
// Mirrors MarketService's contract: best-effort, cached, NEVER throws — network or
// parse failures yield empty/partial results so callers (alert cron, watchlist,
// portfolio, digest) degrade gracefully.
//
// Sources:
//   - dchart-api.vndirect.com.vn  (verified reachable from cloud) — OHLCV history.
//       Prices are in THOUSAND VND (e.g. 24.35 = 24,350đ); kept native like crypto USD.
//   - finfo-api.vndirect.com.vn   (fundamentals + foreign flow) — may be DNS-blocked in
//       some dev sandboxes; coded defensively, verified on the production host.

import { Ticker24h } from './market.service';

const DCHART = 'https://dchart-api.vndirect.com.vn/dchart';
const FINFO = 'https://finfo-api.vndirect.com.vn/v4';
const TTL_MS = 45_000;
const BARS_TTL_MS = 5 * 60_000; // daily bars change at most once/day; refresh modestly
const TIMEOUT_MS = 8_000;
const UA = 'Mozilla/5.0 (compatible; EdgeBookBot/1.0)';

export interface VnDailyBar {
    t: number; // unix seconds
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
}

export interface VnForeign {
    ticker: string;
    netValue: number;  // foreign net buy value (positive = net buy), raw VND
    buyValue: number;
    sellValue: number;
}

export interface VnFundamentals {
    ticker: string;
    pe?: number;
    pb?: number;
    roe?: number;
    eps?: number;
}

interface CacheEntry<T> {
    value: T | null; // null = negative cache (symbol unknown / failed)
    at: number;
}

export class VnStockService {
    private barsCache = new Map<string, CacheEntry<VnDailyBar[]>>();
    private foreignCache = new Map<string, CacheEntry<VnForeign>>();
    private fundCache = new Map<string, CacheEntry<VnFundamentals>>();

    private norm(ticker: string): string {
        return ticker.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    private fresh<T>(entry: CacheEntry<T> | undefined, ttl: number): entry is CacheEntry<T> {
        return entry !== undefined && Date.now() - entry.at < ttl;
    }

    private async fetchJson(url: string): Promise<any | null> {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(TIMEOUT_MS),
                // NB: VNDirect dchart returns 406 when Accept is application/json — must be */*.
                headers: { 'User-Agent': UA, Accept: '*/*' },
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    /**
     * Daily OHLCV bars for a ticker, oldest-first, at most `count` entries.
     * Cached per symbol. Returns [] on failure (never throws).
     */
    async getDailyBars(ticker: string, count = 60): Promise<VnDailyBar[]> {
        const symbol = this.norm(ticker);
        const cached = this.barsCache.get(symbol);
        if (this.fresh(cached, BARS_TTL_MS)) {
            const v = cached!.value;
            return v ? v.slice(-count) : [];
        }

        const now = Math.floor(Date.now() / 1000);
        // Over-fetch calendar days to cover weekends/holidays, then trim.
        const from = now - Math.max(count * 2, 40) * 86_400;
        const url = `${DCHART}/history?symbol=${symbol}&resolution=D&from=${from}&to=${now}`;
        const data = await this.fetchJson(url);

        const bars = this.parseBars(data);
        this.barsCache.set(symbol, { value: bars.length > 0 ? bars : null, at: Date.now() });
        return bars.slice(-count);
    }

    private parseBars(data: any): VnDailyBar[] {
        if (!data || (data.s && data.s !== 'ok') || !Array.isArray(data.t) || !Array.isArray(data.c)) return [];
        const { t, o, h, l, c, v } = data;
        const out: VnDailyBar[] = [];
        for (let i = 0; i < t.length; i++) {
            const close = Number(c[i]);
            if (!Number.isFinite(close)) continue;
            out.push({
                t: Number(t[i]),
                o: Number(o?.[i] ?? close),
                h: Number(h?.[i] ?? close),
                l: Number(l?.[i] ?? close),
                c: close,
                v: Number(v?.[i] ?? 0),
            });
        }
        return out;
    }

    /**
     * Latest price (last daily close) for a list of tickers. Same shape contract as
     * MarketService.getPrices — ticker -> price for known symbols only.
     */
    async getPrices(tickers: string[]): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        await Promise.all(
            tickers.map(async (ticker) => {
                const bars = await this.getDailyBars(ticker, 2);
                const last = bars[bars.length - 1];
                if (last) result.set(ticker, last.c);
            })
        );
        return result;
    }

    /**
     * Price + change% (vs previous close) per ticker. Mirrors MarketService.get24hStats
     * so the router can merge the two markets behind one interface.
     */
    async get24hStats(tickers: string[]): Promise<Map<string, Ticker24h>> {
        const result = new Map<string, Ticker24h>();
        await Promise.all(
            tickers.map(async (ticker) => {
                const bars = await this.getDailyBars(ticker, 2);
                if (bars.length === 0) return;
                const last = bars[bars.length - 1];
                const prev = bars.length >= 2 ? bars[bars.length - 2] : undefined;
                const changePercent = prev && prev.c > 0 ? ((last.c - prev.c) / prev.c) * 100 : 0;
                result.set(ticker, { ticker, price: last.c, changePercent, market: 'vn' });
            })
        );
        return result;
    }

    /**
     * Foreign net buy/sell value for the latest session. finfo-api host — defensive:
     * returns null if unreachable (e.g. dev DNS allowlist) or shape unexpected.
     */
    async getForeignFlow(ticker: string): Promise<VnForeign | null> {
        const symbol = this.norm(ticker);
        const cached = this.foreignCache.get(symbol);
        if (this.fresh(cached, BARS_TTL_MS)) return cached!.value;

        const q = encodeURIComponent(`code:${symbol}`);
        const url = `${FINFO}/foreigns?q=${q}&sort=tradingDate:desc&size=1`;
        const data = await this.fetchJson(url);
        const row = data?.data?.[0];

        let result: VnForeign | null = null;
        if (row) {
            const buyValue = Number(row.buyVal ?? row.buyValue ?? row.netVal ?? 0);
            const sellValue = Number(row.sellVal ?? row.sellValue ?? 0);
            const netValue = Number(row.netVal ?? row.netValue ?? buyValue - sellValue);
            if (Number.isFinite(netValue)) {
                result = { ticker: symbol, netValue, buyValue, sellValue };
            }
        }
        this.foreignCache.set(symbol, { value: result, at: Date.now() });
        return result;
    }

    /**
     * Key fundamentals (P/E, P/B, ROE, EPS). finfo-api host — defensive, returns null
     * on any failure. Field names guarded against minor API drift.
     */
    async getFundamentals(ticker: string): Promise<VnFundamentals | null> {
        const symbol = this.norm(ticker);
        const cached = this.fundCache.get(symbol);
        if (this.fresh(cached, BARS_TTL_MS)) return cached!.value;

        const q = encodeURIComponent(`code:${symbol}`);
        const url = `${FINFO}/ratios/latest?filter=ratioCode:PRICE_TO_EARNINGS,PRICE_TO_BOOK,ROE,EPS_TR&where=code:${symbol}&order=reportDate&fields=ratioCode,value`;
        const data = await this.fetchJson(url);
        const rows: any[] = data?.data ?? [];

        let result: VnFundamentals | null = null;
        if (Array.isArray(rows) && rows.length > 0) {
            const pick = (code: string) => {
                const r = rows.find((x) => x.ratioCode === code);
                const n = r ? Number(r.value) : NaN;
                return Number.isFinite(n) ? n : undefined;
            };
            result = {
                ticker: symbol,
                pe: pick('PRICE_TO_EARNINGS'),
                pb: pick('PRICE_TO_BOOK'),
                roe: pick('ROE'),
                eps: pick('EPS_TR'),
            };
        }
        this.fundCache.set(symbol, { value: result, at: Date.now() });
        return result;
    }
}
