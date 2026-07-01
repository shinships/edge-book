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
// Dividend/capital-increase calendar — same host, sibling path. Newest-first; INCLUDES
// forward-dated (announced-but-not-yet-reached) events, confirmed by spike (SAB had a
// 2026-07-27 entry while "today" was 2026-07-01) — so it can power lead-time reminders.
const EVENTS_URL = 'https://cafef.vn/du-lieu/Ajax/PageNew/LichSuKien.ashx';
const TTL_MS = 5 * 60_000; // EOD data changes at most once/day; modest refresh
const TIMEOUT_MS = 8_000;
const UA = 'Mozilla/5.0 (compatible; EdgeBookBot/1.0)';

export interface FlowDay {
    date: string;       // 'dd/MM/yyyy'
    netValue: number;   // VND, positive = net buy
    buyValue: number;
    sellValue: number;
}

export interface DividendEvent {
    date: string;                          // 'yyyy-mm-dd' (VN local)
    dateKind: 'exRights' | 'issuance';     // exRights = ngày GDKHQ (cổ tức/thưởng); issuance = ngày phát hành (vd ESOP)
    text: string;                          // joined description, e.g. "Cổ tức bằng Tiền, tỷ lệ 10%"
}

export interface InsiderTx {
    ticker: string;
    person: string;        // who actually transacts
    role: string;          // their company position, or the relationship if via a related person
    isRelated: boolean;    // true = transacted by a related person (NLQ) of an insider
    relatedTo?: string;    // the insider the person is related to
    side: 'buy' | 'sell' | 'unknown';
    planVolume: number;    // registered (đăng ký) volume, shares
    realBuy: number;       // executed buy volume
    realSell: number;      // executed sell volume
    beginDate?: string;    // 'yyyy-mm-dd' (registration window)
    endDate?: string;
    publishedDate?: string;
    publishedMs: number;   // epoch ms of the filing (0 if missing) — used for new-filing detection
}

// Parse Microsoft JSON date "/Date(1782284414940)/" → epoch ms (0 if absent).
function msDate(s: any): number {
    const m = /\/Date\((\d+)\)\//.exec(String(s ?? ''));
    return m ? Number(m[1]) : 0;
}

// epoch ms → 'yyyy-mm-dd' in VN local time (UTC+7); undefined if 0.
function vnDate(ms: number): string | undefined {
    if (!ms) return undefined;
    return new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
}

interface CacheEntry {
    value: FlowDay[] | null; // null = negative cache (unknown symbol / failure)
    at: number;
}

interface InsiderCacheEntry {
    value: InsiderTx[] | null;
    at: number;
}

interface EventsCacheEntry {
    value: DividendEvent[] | null;
    at: number;
}

export class CafefService {
    private propCache = new Map<string, CacheEntry>();
    private foreignCache = new Map<string, CacheEntry>();
    private insiderCache = new Map<string, InsiderCacheEntry>();
    private eventsCache = new Map<string, EventsCacheEntry>();

    private norm(t: string): string {
        return t.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    private fresh<T extends { at: number }>(e: T | undefined): e is T {
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

    /**
     * Insider / related-person registered transactions (giao dịch cổ đông nội bộ),
     * newest-first. CafeF `gdcodong.ashx`. Returns [] on failure (never throws).
     */
    async getInsiderTransactions(ticker: string, size = 5): Promise<InsiderTx[]> {
        const symbol = this.norm(ticker);
        const cached = this.insiderCache.get(symbol);
        if (this.fresh(cached)) return cached.value ? cached.value.slice(0, size) : [];

        const url = `${BASE}/gdcodong.ashx?Symbol=${symbol}&PageIndex=1&PageSize=${Math.max(size, 10)}`;
        const data = await this.fetchJson(url);
        const rows: any[] = data?.Data?.Data ?? [];

        const out: InsiderTx[] = [];
        if (Array.isArray(rows)) {
            for (const r of rows) {
                const planBuy = Number(r.PlanBuyVolume ?? 0);
                const planSell = Number(r.PlanSellVolume ?? 0);
                const side: InsiderTx['side'] = planBuy > 0 ? 'buy' : planSell > 0 ? 'sell' : 'unknown';
                // When RelatedMan is set, the transactor is a related person (NLQ) of that
                // insider, and TransactionManPosition holds the *relationship* (e.g. "Con").
                const isRelated = !!String(r.RelatedMan ?? '').trim();
                out.push({
                    ticker: symbol,
                    person: String(r.TransactionMan ?? '').trim(),
                    role: String(r.TransactionManPosition ?? '').trim(),
                    isRelated,
                    relatedTo: isRelated ? String(r.RelatedMan ?? '').trim() : undefined,
                    side,
                    planVolume: side === 'buy' ? planBuy : side === 'sell' ? planSell : 0,
                    realBuy: Number(r.RealBuyVolume ?? 0),
                    realSell: Number(r.RealSellVolume ?? 0),
                    beginDate: vnDate(msDate(r.PlanBeginDate)),
                    endDate: vnDate(msDate(r.PlanEndDate)),
                    publishedDate: vnDate(msDate(r.PublishedDate)),
                    publishedMs: msDate(r.PublishedDate),
                });
            }
        }
        this.insiderCache.set(symbol, { value: out.length ? out : null, at: Date.now() });
        return out.slice(0, size);
    }

    /**
     * Dividend / capital-increase calendar (GDKHQ ex-rights date for cash/stock dividends,
     * issuance date for ESOP/private placements), newest-first — includes forward-dated
     * (already-announced) entries. CafeF `LichSuKien.ashx`. Returns [] on failure (never throws).
     */
    async getDividendEvents(ticker: string, size = 10): Promise<DividendEvent[]> {
        const symbol = this.norm(ticker);
        const cached = this.eventsCache.get(symbol);
        if (this.fresh(cached)) return cached.value ? cached.value.slice(0, size) : [];

        const url = `${EVENTS_URL}?Symbol=${symbol}`;
        const data = await this.fetchJson(url);
        const rows: any[] = data?.Data ?? [];

        const out: DividendEvent[] = [];
        if (Array.isArray(rows)) {
            for (const r of rows) {
                const date = vnDate(msDate(r.Time));
                const texts: string[] = Array.isArray(r.Text) ? r.Text : [];
                if (!date || texts.length === 0) continue;
                out.push({ date, dateKind: Number(r.type) === 2 ? 'issuance' : 'exRights', text: texts.join('; ') });
            }
        }
        this.eventsCache.set(symbol, { value: out.length ? out : null, at: Date.now() });
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
