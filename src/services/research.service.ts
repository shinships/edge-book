import { db } from '../db';
import { researchItems } from '../db/schema';
import { eq, and, ilike, gte, desc } from 'drizzle-orm';

// --- Interfaces ---

export interface ResearchItem {
    id: string;
    userId: number;
    content: string;
    sourceName?: string;
    sourceUrl?: string;
    tickers: string[];
    categories: string[];
    sentiment: number;
    isStarred: boolean;
    googleDocId?: string;
    createdAt: string;
}

// --- Common crypto tickers for regex-based extraction ---
const KNOWN_TICKERS = [
    // Top crypto
    'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK',
    'ATOM', 'UNI', 'LTC', 'NEAR', 'APT', 'ARB', 'OP', 'SUI', 'SEI', 'TIA',
    'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME',
    'FIL', 'INJ', 'TRX', 'TON', 'FTM', 'RUNE', 'AAVE', 'MKR', 'CRV', 'SNX',
    'DYDX', 'GMX', 'JUP', 'JTO', 'PYTH', 'W', 'STRK', 'MANTA', 'DYM',
    // Stablecoins
    'USDT', 'USDC', 'DAI', 'BUSD',
    // VN stocks (common)
    'VNM', 'VCB', 'FPT', 'MBB', 'VPB', 'HPG', 'VHM', 'MSN', 'TCB', 'ACB',
    'VIC', 'SAB', 'GAS', 'PLX', 'SSI', 'HDB', 'STB', 'MWG', 'PNJ', 'REE',
    // US stocks (common)
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AMD', 'INTC',
    // Forex
    'DXY', 'XAUUSD', 'GOLD',
];

const TICKER_SET = new Set(KNOWN_TICKERS);

const CATEGORY_KEYWORDS: Record<string, string[]> = {
    technical: ['support', 'resistance', 'breakout', 'breakdown', 'RSI', 'MACD', 'EMA', 'SMA',
        'fibonacci', 'fib', 'trendline', 'channel', 'pattern', 'chart', 'candle', 'volume',
        'divergence', 'overbought', 'oversold', 'target', 'test', 'retest', 'vùng', 'kháng cự',
        'hỗ trợ', 'break', 'pump', 'dump', 'ATH', 'ATL', 'higher high', 'lower low'],
    macro: ['CPI', 'GDP', 'fed', 'FOMC', 'interest rate', 'inflation', 'unemployment', 'payroll',
        'recession', 'QE', 'QT', 'yield', 'bond', 'treasury', 'dollar', 'DXY', 'macro',
        'lãi suất', 'lạm phát', 'kinh tế'],
    'on-chain': ['whale', 'exchange flow', 'netflow', 'TVL', 'staking', 'unstaking', 'bridge',
        'gas fee', 'miner', 'hash rate', 'active addresses', 'glassnode', 'nansen', 'dune',
        'on-chain', 'onchain', 'blockchain', 'smart contract', 'airdrop', 'farming', 'DEX',
        'CEX', 'liquidity', 'pool'],
    fundamental: ['revenue', 'earnings', 'partnership', 'funding', 'valuation', 'market cap',
        'tokenomics', 'roadmap', 'whitepaper', 'team', 'VC', 'investor', 'protocol', 'upgrade',
        'launch', 'mainnet', 'testnet', 'audit', 'doanh thu', 'lợi nhuận'],
    alpha: ['alpha', 'gem', 'early', 'insider', 'presale', 'IDO', 'ICO', 'launchpad',
        'narrative', 'meta', 'trend', 'rotation', '100x', '10x', 'undervalued', 'hidden gem',
        'kèo', 'signal', 'call'],
};

type ResearchRow = typeof researchItems.$inferSelect;

function toItem(row: ResearchRow): ResearchItem {
    return {
        id: row.id,
        userId: row.userId,
        content: row.content,
        sourceName: row.sourceName ?? undefined,
        sourceUrl: row.sourceUrl ?? undefined,
        tickers: row.tickers ?? [],
        categories: row.categories ?? [],
        sentiment: row.sentiment,
        isStarred: row.isStarred,
        googleDocId: row.googleDocId ?? undefined,
        createdAt: row.createdAt.toISOString(),
    };
}

// --- Service ---

export class ResearchService {
    // --- Auto-tagging (pure, no DB) ---

    extractTickers(text: string): string[] {
        const found = new Set<string>();

        const dollarPattern = /\$([A-Z]{2,10})/gi;
        let match;
        while ((match = dollarPattern.exec(text)) !== null) {
            const ticker = match[1].toUpperCase();
            if (TICKER_SET.has(ticker)) found.add(ticker);
        }

        const pairPattern = /\b([A-Z]{2,10})\s*[\/\-]\s*([A-Z]{2,10})\b/gi;
        while ((match = pairPattern.exec(text)) !== null) {
            const t1 = match[1].toUpperCase();
            const t2 = match[2].toUpperCase();
            if (TICKER_SET.has(t1)) found.add(t1);
            if (TICKER_SET.has(t2)) found.add(t2);
        }

        for (const ticker of KNOWN_TICKERS) {
            if (ticker.length >= 3) {
                const regex = new RegExp(`\\b${ticker}\\b`, 'gi');
                if (regex.test(text)) found.add(ticker);
            }
        }

        found.delete('USDT');
        found.delete('USDC');
        found.delete('DAI');
        found.delete('BUSD');

        return Array.from(found);
    }

    classifyCategories(text: string): string[] {
        const categories: string[] = [];
        const lowerText = text.toLowerCase();

        for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
            const matchCount = keywords.filter((kw) => lowerText.includes(kw.toLowerCase())).length;
            if (matchCount >= 2) categories.push(category);
        }

        if (categories.length === 0) categories.push('general');
        return categories;
    }

    scoreSentiment(text: string): number {
        const lowerText = text.toLowerCase();

        const bullishWords = ['bullish', 'buy', 'long', 'breakout', 'pump', 'moon', 'accumulate',
            'uptrend', 'higher high', 'support', 'mua', 'tăng', 'tích cực', 'target',
            'ATH', 'rally', 'recovery', 'bounce', 'green', 'strong'];
        const bearishWords = ['bearish', 'sell', 'short', 'breakdown', 'dump', 'crash', 'distribute',
            'downtrend', 'lower low', 'resistance', 'bán', 'giảm', 'tiêu cực',
            'ATL', 'correction', 'drop', 'red', 'weak', 'fear'];

        let score = 0;
        bullishWords.forEach((w) => { if (lowerText.includes(w)) score += 0.15; });
        bearishWords.forEach((w) => { if (lowerText.includes(w)) score -= 0.15; });

        return Math.max(-1, Math.min(1, Math.round(score * 100) / 100));
    }

    // --- CRUD Operations ---

    async addItem(userId: number, content: string, sourceName?: string): Promise<ResearchItem> {
        const id = `r_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const [row] = await db.insert(researchItems).values({
            id,
            userId,
            content,
            sourceName,
            tickers: this.extractTickers(content),
            categories: this.classifyCategories(content),
            sentiment: this.scoreSentiment(content),
            isStarred: false,
            createdAt: new Date(),
        }).returning();
        return toItem(row!);
    }

    async getItems(userId: number): Promise<ResearchItem[]> {
        const rows = await db.select()
            .from(researchItems)
            .where(eq(researchItems.userId, userId))
            .orderBy(researchItems.createdAt);
        return rows.map(toItem);
    }

    async getItemById(userId: number, itemId: string): Promise<ResearchItem | undefined> {
        const [row] = await db.select()
            .from(researchItems)
            .where(and(eq(researchItems.id, itemId), eq(researchItems.userId, userId)));
        return row ? toItem(row) : undefined;
    }

    async toggleStar(userId: number, itemId: string): Promise<ResearchItem | null> {
        const [existing] = await db.select()
            .from(researchItems)
            .where(and(eq(researchItems.id, itemId), eq(researchItems.userId, userId)));
        if (!existing) return null;
        const [updated] = await db.update(researchItems)
            .set({ isStarred: !existing.isStarred })
            .where(eq(researchItems.id, itemId))
            .returning();
        return toItem(updated!);
    }

    async starLatest(userId: number): Promise<ResearchItem | null> {
        const [latest] = await db.select()
            .from(researchItems)
            .where(eq(researchItems.userId, userId))
            .orderBy(desc(researchItems.createdAt))
            .limit(1);
        if (!latest) return null;
        const [updated] = await db.update(researchItems)
            .set({ isStarred: true })
            .where(eq(researchItems.id, latest.id))
            .returning();
        return toItem(updated!);
    }

    async searchByTicker(userId: number, ticker: string): Promise<ResearchItem[]> {
        const upper = ticker.toUpperCase();
        // Use array overlap — research items whose tickers array contains this ticker
        const all = await this.getItems(userId);
        return all.filter((item) => item.tickers.includes(upper));
    }

    async searchByKeyword(userId: number, keyword: string): Promise<ResearchItem[]> {
        const rows = await db.select()
            .from(researchItems)
            .where(and(
                eq(researchItems.userId, userId),
                ilike(researchItems.content, `%${keyword}%`)
            ));
        return rows.map(toItem);
    }

    async searchByCategory(userId: number, category: string): Promise<ResearchItem[]> {
        const lowerCat = category.toLowerCase();
        const all = await this.getItems(userId);
        return all.filter((item) => item.categories.includes(lowerCat));
    }

    async getNewest(userId: number, limit = 10): Promise<ResearchItem[]> {
        const rows = await db.select()
            .from(researchItems)
            .where(eq(researchItems.userId, userId))
            .orderBy(desc(researchItems.createdAt))
            .limit(limit);
        return rows.map(toItem);
    }

    async getRecentItems(userId: number, hours = 24): Promise<ResearchItem[]> {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        const rows = await db.select()
            .from(researchItems)
            .where(and(
                eq(researchItems.userId, userId),
                gte(researchItems.createdAt, cutoff)
            ))
            .orderBy(researchItems.createdAt);
        return rows.map(toItem);
    }

    async getStarredItems(userId: number): Promise<ResearchItem[]> {
        const rows = await db.select()
            .from(researchItems)
            .where(and(eq(researchItems.userId, userId), eq(researchItems.isStarred, true)))
            .orderBy(researchItems.createdAt);
        return rows.map(toItem);
    }

    async getDigestData(userId: number, hours = 24): Promise<{
        totalItems: number;
        topTickers: { ticker: string; count: number; items: ResearchItem[] }[];
        uncategorized: ResearchItem[];
    }> {
        const recentItems = await this.getRecentItems(userId, hours);

        const tickerMap = new Map<string, ResearchItem[]>();
        const uncategorized: ResearchItem[] = [];

        for (const item of recentItems) {
            if (item.tickers.length === 0) {
                uncategorized.push(item);
            } else {
                for (const ticker of item.tickers) {
                    if (!tickerMap.has(ticker)) tickerMap.set(ticker, []);
                    tickerMap.get(ticker)!.push(item);
                }
            }
        }

        const topTickers = Array.from(tickerMap.entries())
            .map(([ticker, items]) => ({ ticker, count: items.length, items }))
            .sort((a, b) => b.count - a.count);

        return { totalItems: recentItems.length, topTickers, uncategorized };
    }

    async getWeeklyReportData(userId: number): Promise<{
        totalItems: number;
        prevTotalItems: number;
        topTickers: { ticker: string; count: number; items: ResearchItem[] }[];
        sentimentShifts: { ticker: string; thisAvg: number; prevAvg: number | null; shift: number | null; count: number }[];
    }> {
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const weekAgo = new Date(now - weekMs).toISOString();
        const twoWeeksAgo = new Date(now - 2 * weekMs).toISOString();

        const items = await this.getItems(userId);
        const thisWeek = items.filter((i) => i.createdAt >= weekAgo);
        const prevWeek = items.filter((i) => i.createdAt >= twoWeeksAgo && i.createdAt < weekAgo);

        const avgSentiment = (list: ResearchItem[]): number | null =>
            list.length === 0 ? null : Math.round((list.reduce((s, i) => s + i.sentiment, 0) / list.length) * 100) / 100;

        const tickerMap = new Map<string, ResearchItem[]>();
        for (const item of thisWeek) {
            for (const ticker of item.tickers) {
                if (!tickerMap.has(ticker)) tickerMap.set(ticker, []);
                tickerMap.get(ticker)!.push(item);
            }
        }
        const topTickers = Array.from(tickerMap.entries())
            .map(([ticker, items]) => ({ ticker, count: items.length, items }))
            .sort((a, b) => b.count - a.count);

        const sentimentShifts = topTickers.slice(0, 8).map(({ ticker, items, count }) => {
            const thisAvg = avgSentiment(items) ?? 0;
            const prevItems = prevWeek.filter((i) => i.tickers.includes(ticker));
            const prevAvg = avgSentiment(prevItems);
            const shift = prevAvg === null ? null : Math.round((thisAvg - prevAvg) * 100) / 100;
            return { ticker, thisAvg, prevAvg, shift, count };
        });

        return {
            totalItems: thisWeek.length,
            prevTotalItems: prevWeek.length,
            topTickers,
            sentimentShifts,
        };
    }

    async getStats(userId: number): Promise<{
        totalItems: number;
        starredCount: number;
        topTickers: { ticker: string; count: number }[];
        todayCount: number;
        thisWeekCount: number;
    }> {
        const items = await this.getItems(userId);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const tickerCounts = new Map<string, number>();
        for (const item of items) {
            for (const ticker of item.tickers) {
                tickerCounts.set(ticker, (tickerCounts.get(ticker) || 0) + 1);
            }
        }

        const topTickers = Array.from(tickerCounts.entries())
            .map(([ticker, count]) => ({ ticker, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return {
            totalItems: items.length,
            starredCount: items.filter((i) => i.isStarred).length,
            topTickers,
            todayCount: items.filter((i) => i.createdAt >= todayStart).length,
            thisWeekCount: items.filter((i) => i.createdAt >= weekStart).length,
        };
    }

    async getTodayCount(userId: number): Promise<number> {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const rows = await db.select()
            .from(researchItems)
            .where(and(
                eq(researchItems.userId, userId),
                gte(researchItems.createdAt, todayStart)
            ));
        return rows.length;
    }

    async getAllUserIds(): Promise<number[]> {
        const rows = await db.selectDistinct({ userId: researchItems.userId }).from(researchItems);
        return rows.map((r) => r.userId);
    }
}
