// CafefService — VN money-flow (foreign + proprietary/tự doanh) via CafeF public ajax.
// Multi-session history → enables streak + threshold alerts. Best-effort, cached,
// NEVER throws (mirrors VnStockService contract). No key/auth.
//
// Source: cafef.vn/du-lieu/ajax/pagenew/datahistory/{gdtudoanh,gdkhoingoai}.ashx
//   ⚠️ Must hit the canonical host `cafef.vn/du-lieu/...` directly; the legacy
//   `s.cafef.vn/Ajax/...` alias 301-redirects to a URL that DROPS the query string.
//   Reachable from dev too — unlike finfo-api.vndirect.com.vn, which resolves to a
//   private IP (10.x) and so can't be used for proprietary data from outside the VPC.

const BASE = 'https://cafef.vn/du-lieu/ajax/pagenew/datahistory';
const TTL_MS = 5 * 60_000; // EOD data changes at most once/day; modest refresh
const TIMEOUT_MS = 8_000;
const UA = 'Mozilla/5.0 (compatible; EdgeBookBot/1.0)';

export interface FlowDay {
    date: string;       // 'dd/MM/yyyy'
    netValue: number;   // VND, positive = net buy
    buyValue: number;
    sellValue: number;
}

interface CacheEntry {
    value: FlowDay[] | null; // null = negative cache (unknown symbol / failure)
    at: number;
}

export class CafefService {
    private propCache = new Map<string, CacheEntry>();
    private foreignCache = new Map<string, CacheEntry>();

    private norm(t: string): string {
        return t.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    private fresh(e: CacheEntry | undefined): e is CacheEntry {
        return e !== undefined && Date.now() - e.at < TTL_MS;
    }

    private async fetchJson(url: string): Promise<any | null> {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(TIMEOUT_MS),
                headers: { 'User-Agent': UA, Accept: '*/*' },
            });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    /**
     * Proprietary (tự doanh CTCK) net buy/sell per session, newest-first.
     * Returns [] on failure (never throws).
     */
    async getProprietarySeries(ticker: string, size = 5): Promise<FlowDay[]> {
        const symbol = this.norm(ticker);
        const cached = this.propCache.get(symbol);
        if (this.fresh(cached)) return cached.value ? cached.value.slice(0, size) : [];

        const url = `${BASE}/gdtudoanh.ashx?Symbol=${symbol}&PageIndex=1&PageSize=${Math.max(size, 5)}`;
        const data = await this.fetchJson(url);
        const rows: any[] = data?.Data?.Data?.ListDataTudoanh ?? [];

        const out: FlowDay[] = [];
        if (Array.isArray(rows)) {
            for (const r of rows) {
                const buy = Number(r.GtMua);
                const sell = Number(r.GtBan);
                if (!Number.isFinite(buy) || !Number.isFinite(sell)) continue;
                out.push({ date: String(r.Date ?? ''), buyValue: buy, sellValue: sell, netValue: buy - sell });
            }
        }
        this.propCache.set(symbol, { value: out.length ? out : null, at: Date.now() });
        return out.slice(0, size);
    }

    /**
     * Foreign (khối ngoại) net buy/sell per session, newest-first.
     * Returns [] on failure (never throws).
     */
    async getForeignSeries(ticker: string, size = 5): Promise<FlowDay[]> {
        const symbol = this.norm(ticker);
        const cached = this.foreignCache.get(symbol);
        if (this.fresh(cached)) return cached.value ? cached.value.slice(0, size) : [];

        const url = `${BASE}/gdkhoingoai.ashx?Symbol=${symbol}&PageIndex=1&PageSize=${Math.max(size, 5)}`;
        const data = await this.fetchJson(url);
        const rows: any[] = data?.Data?.Data ?? [];

        const out: FlowDay[] = [];
        if (Array.isArray(rows)) {
            for (const r of rows) {
                const net = Number(r.GTDGRong);
                if (!Number.isFinite(net)) continue;
                out.push({
                    date: String(r.Ngay ?? ''),
                    netValue: net,
                    buyValue: Number(r.GtMua ?? 0),
                    sellValue: Number(r.GtBan ?? 0),
                });
            }
        }
        this.foreignCache.set(symbol, { value: out.length ? out : null, at: Date.now() });
        return out.slice(0, size);
    }
}

/**
 * Number of consecutive sessions (counting from the newest) where the net flow
 * matches `side`. 'buy' → netValue > 0; 'sell' → netValue < 0. Stops at the first
 * session that breaks the streak.
 */
export function flowStreak(days: FlowDay[], side: 'buy' | 'sell'): number {
    let n = 0;
    for (const d of days) {
        const ok = side === 'buy' ? d.netValue > 0 : d.netValue < 0;
        if (!ok) break;
        n++;
    }
    return n;
}
