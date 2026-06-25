// MarketRouter — single facade over crypto (Binance) and VN stock (VNDirect) price
// sources. Exposes the same getPrices()/get24hStats() contract MarketService had, so
// existing callers (alert cron, watchlist, digest, portfolio) don't change shape; it
// classifies each ticker, fans out to the right service, and merges the results.

import { MarketService, Ticker24h } from './market.service';
import { VnStockService } from './vn-stock.service';

export type Market = 'crypto' | 'vn';

// Common crypto bases — checked BEFORE the 3-letter VN heuristic so that 3-letter coins
// (BTC, ETH, SOL...) aren't misrouted to the VN source. Gold aliases map to PAXG upstream.
const CRYPTO_BASES = new Set([
    'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC', 'POL',
    'LINK', 'LTC', 'BCH', 'TRX', 'SHIB', 'PEPE', 'UNI', 'ATOM', 'NEAR', 'APT', 'ARB',
    'OP', 'SUI', 'TON', 'FIL', 'ETC', 'XLM', 'ALGO', 'ICP', 'INJ', 'TIA', 'SEI', 'FTM',
    'USDT', 'USDC', 'DAI', 'BUSD', 'XAU', 'XAUUSD', 'GOLD', 'PAXG', 'WBTC',
]);

const VN_INDICES = new Set(['VNINDEX', 'VN30', 'VN100', 'HNX', 'HNXINDEX', 'HNX30', 'UPCOM', 'UPINDEX']);

export class MarketRouter {
    constructor(
        private readonly crypto: MarketService,
        private readonly vn: VnStockService
    ) {}

    /** Decide which market a ticker belongs to. Crypto allowlist wins; otherwise a
     *  pure 3-letter code (and known VN indices) is treated as a VN stock. */
    classify(ticker: string): Market {
        const base = ticker.toUpperCase().split(/[./-]/)[0].replace(/[^A-Z0-9]/g, '');
        if (CRYPTO_BASES.has(base)) return 'crypto';
        if (VN_INDICES.has(base)) return 'vn';
        if (/^[A-Z]{3}$/.test(base)) return 'vn';
        return 'crypto';
    }

    private split(tickers: string[]): { crypto: string[]; vn: string[] } {
        const c: string[] = [];
        const v: string[] = [];
        for (const t of tickers) (this.classify(t) === 'vn' ? v : c).push(t);
        return { crypto: c, vn: v };
    }

    async getPrices(tickers: string[]): Promise<Map<string, number>> {
        const { crypto, vn } = this.split(tickers);
        const [cMap, vMap] = await Promise.all([
            crypto.length ? this.crypto.getPrices(crypto) : Promise.resolve(new Map<string, number>()),
            vn.length ? this.vn.getPrices(vn) : Promise.resolve(new Map<string, number>()),
        ]);
        const out = new Map<string, number>();
        for (const [k, val] of cMap) out.set(k, val);
        for (const [k, val] of vMap) out.set(k, val);
        return out;
    }

    async get24hStats(tickers: string[]): Promise<Map<string, Ticker24h>> {
        const { crypto, vn } = this.split(tickers);
        const [cMap, vMap] = await Promise.all([
            crypto.length ? this.crypto.get24hStats(crypto) : Promise.resolve(new Map<string, Ticker24h>()),
            vn.length ? this.vn.get24hStats(vn) : Promise.resolve(new Map<string, Ticker24h>()),
        ]);
        const out = new Map<string, Ticker24h>();
        for (const [k, val] of cMap) out.set(k, { ...val, market: 'crypto' });
        for (const [k, val] of vMap) out.set(k, val); // VnStockService already tags market: 'vn'
        return out;
    }
}
