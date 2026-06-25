// MarketService — live crypto prices via Binance public REST API (no key needed).
// All methods are best-effort: network/parse errors yield empty/partial maps,
// never throw, so callers (alert cron, watchlist, digest) degrade gracefully.

export interface Ticker24h {
    ticker: string;
    price: number;
    changePercent: number;
    market?: 'crypto' | 'vn'; // source market; undefined treated as crypto for back-compat
}

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const TTL_MS = 45_000;
const TIMEOUT_MS = 8_000;

interface CacheEntry<T> {
    value: T | null; // null = negative cache (symbol unknown / failed)
    at: number;
}

export class MarketService {
    private priceCache = new Map<string, CacheEntry<number>>();
    private statsCache = new Map<string, CacheEntry<Ticker24h>>();

    // Một số ticker không có cặp USDT trực tiếp trên Binance — map về token tương đương.
    // Vàng (XAU/XAUUSD/GOLD) -> PAXG (PAX Gold, 1 PAXG ≈ 1 oz vàng, giá bám sát spot).
    private static readonly BASE_ALIAS: Record<string, string> = {
        XAU: 'PAXG',
        XAUUSD: 'PAXG',
        GOLD: 'PAXG',
    };

    // Map a ticker to a Binance USDT symbol. Strips any pair suffix first so
    // "ETH/USDT" -> "ETHUSDT", not "ETHUSDTUSDT".
    private toSymbol(ticker: string): string {
        const raw = ticker.toUpperCase().split(/[./-]/)[0].replace(/[^A-Z0-9]/g, '');
        const base = MarketService.BASE_ALIAS[raw] ?? raw;
        return base + 'USDT';
    }

    private fresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
        return entry !== undefined && Date.now() - entry.at < TTL_MS;
    }

    private async fetchJson(url: string): Promise<any | null> {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    /**
     * Batch current prices for a list of tickers. Returns ticker -> price for
     * known symbols only. Used by the per-minute alert cron, so it must be cheap.
     */
    async getPrices(tickers: string[]): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        const need: { ticker: string; symbol: string }[] = [];

        for (const ticker of tickers) {
            const symbol = this.toSymbol(ticker);
            const cached = this.priceCache.get(symbol);
            if (this.fresh(cached)) {
                if (cached!.value !== null) result.set(ticker, cached!.value);
            } else {
                need.push({ ticker, symbol });
            }
        }
        if (need.length === 0) return result;

        const symbols = [...new Set(need.map((n) => n.symbol))];
        const batchUrl = `${BINANCE_BASE}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
        const batch = await this.fetchJson(batchUrl);

        if (Array.isArray(batch)) {
            const priceBySymbol = new Map<string, number>();
            for (const row of batch) {
                const p = parseFloat(row.price);
                if (Number.isFinite(p)) priceBySymbol.set(row.symbol, p);
            }
            const now = Date.now();
            for (const { ticker, symbol } of need) {
                const p = priceBySymbol.get(symbol);
                if (p !== undefined) {
                    this.priceCache.set(symbol, { value: p, at: now });
                    result.set(ticker, p);
                } else {
                    this.priceCache.set(symbol, { value: null, at: now }); // negative-cache unknowns
                }
            }
            return result;
        }

        // Batch failed (one bad symbol -> whole batch 400). Fall back per-symbol.
        for (const { ticker, symbol } of need) {
            const single = await this.fetchJson(`${BINANCE_BASE}/ticker/price?symbol=${symbol}`);
            const p = single ? parseFloat(single.price) : NaN;
            if (Number.isFinite(p)) {
                this.priceCache.set(symbol, { value: p, at: Date.now() });
                result.set(ticker, p);
            } else {
                this.priceCache.set(symbol, { value: null, at: Date.now() });
            }
        }
        return result;
    }

    /**
     * Batch 24h price + change% for a list of tickers (Watchlist, digest).
     */
    async get24hStats(tickers: string[]): Promise<Map<string, Ticker24h>> {
        const result = new Map<string, Ticker24h>();
        const need: { ticker: string; symbol: string }[] = [];

        for (const ticker of tickers) {
            const symbol = this.toSymbol(ticker);
            const cached = this.statsCache.get(symbol);
            if (this.fresh(cached)) {
                if (cached!.value !== null) result.set(ticker, { ...cached!.value, ticker });
            } else {
                need.push({ ticker, symbol });
            }
        }
        if (need.length === 0) return result;

        const symbols = [...new Set(need.map((n) => n.symbol))];
        const batchUrl = `${BINANCE_BASE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
        const batch = await this.fetchJson(batchUrl);

        const apply = (ticker: string, symbol: string, row: any | null) => {
            const price = row ? parseFloat(row.lastPrice) : NaN;
            const change = row ? parseFloat(row.priceChangePercent) : NaN;
            if (Number.isFinite(price) && Number.isFinite(change)) {
                const stat: Ticker24h = { ticker, price, changePercent: change };
                this.statsCache.set(symbol, { value: { ...stat }, at: Date.now() });
                result.set(ticker, stat);
            } else {
                this.statsCache.set(symbol, { value: null, at: Date.now() });
            }
        };

        if (Array.isArray(batch)) {
            const rowBySymbol = new Map<string, any>();
            for (const row of batch) rowBySymbol.set(row.symbol, row);
            for (const { ticker, symbol } of need) apply(ticker, symbol, rowBySymbol.get(symbol) ?? null);
            return result;
        }

        // Fallback per-symbol on batch failure.
        for (const { ticker, symbol } of need) {
            const single = await this.fetchJson(`${BINANCE_BASE}/ticker/24hr?symbol=${symbol}`);
            apply(ticker, symbol, single);
        }
        return result;
    }
}
