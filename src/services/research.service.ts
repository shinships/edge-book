import * as fs from 'fs';
import * as path from 'path';

// --- Interfaces ---

export interface ResearchItem {
    id: string;
    userId: number;
    content: string;
    sourceName?: string;       // Forwarded from channel/user name
    sourceUrl?: string;
    tickers: string[];         // ['BTC', 'ETH', 'SOL']
    categories: string[];     // ['technical', 'macro', 'on-chain', 'fundamental', 'alpha']
    sentiment: number;         // -1.0 (bearish) to 1.0 (bullish), 0 = neutral
    isStarred: boolean;
    googleDocId?: string;      // linked Google Doc
    createdAt: string;         // ISO string
}

export interface UserResearch {
    userId: number;
    items: ResearchItem[];
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

// Build a set for O(1) lookup
const TICKER_SET = new Set(KNOWN_TICKERS);

// --- Category keywords ---
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

// --- Service ---

export class ResearchService {
    private dataPath: string;
    private research: Map<number, ResearchItem[]>;

    constructor() {
        this.dataPath = path.resolve(__dirname, '../../data/research.json');
        this.research = new Map();
        this.loadData();
    }

    // --- Persistence ---

    private loadData() {
        if (fs.existsSync(this.dataPath)) {
            try {
                const rawData = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(rawData);
                if (Array.isArray(parsed)) {
                    parsed.forEach((u: UserResearch) => this.research.set(u.userId, u.items));
                }
            } catch (error) {
                console.error('Error loading research data:', error);
            }
        }
    }

    private saveData() {
        try {
            const data: UserResearch[] = Array.from(this.research.entries()).map(([userId, items]) => ({
                userId,
                items,
            }));
            // Ensure data directory exists
            const dir = path.dirname(this.dataPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Error saving research data:', error);
        }
    }

    // --- Auto-tagging ---

    /**
     * Extract ticker symbols from text using regex.
     * Matches $BTC, BTC/USDT, BTC-PERP, and standalone known tickers.
     */
    extractTickers(text: string): string[] {
        const found = new Set<string>();

        // Pattern 1: $BTC style
        const dollarPattern = /\$([A-Z]{2,10})/gi;
        let match;
        while ((match = dollarPattern.exec(text)) !== null) {
            const ticker = match[1].toUpperCase();
            if (TICKER_SET.has(ticker)) {
                found.add(ticker);
            }
        }

        // Pattern 2: BTC/USDT, ETH/BTC pair style
        const pairPattern = /\b([A-Z]{2,10})\s*[\/\-]\s*([A-Z]{2,10})\b/gi;
        while ((match = pairPattern.exec(text)) !== null) {
            const t1 = match[1].toUpperCase();
            const t2 = match[2].toUpperCase();
            if (TICKER_SET.has(t1)) found.add(t1);
            if (TICKER_SET.has(t2)) found.add(t2);
        }

        // Pattern 3: Standalone known tickers (word boundary match)
        for (const ticker of KNOWN_TICKERS) {
            // Only match tickers with 3+ chars to avoid false positives (e.g. "W", "OP")
            if (ticker.length >= 3) {
                const regex = new RegExp(`\\b${ticker}\\b`, 'gi');
                if (regex.test(text)) {
                    found.add(ticker);
                }
            }
        }

        // Remove stablecoins from results (they're noise in research context)
        found.delete('USDT');
        found.delete('USDC');
        found.delete('DAI');
        found.delete('BUSD');

        return Array.from(found);
    }

    /**
     * Classify content into categories based on keyword matching.
     */
    classifyCategories(text: string): string[] {
        const categories: string[] = [];
        const lowerText = text.toLowerCase();

        for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
            const matchCount = keywords.filter(kw => lowerText.includes(kw.toLowerCase())).length;
            // Require at least 2 keyword matches to reduce false positives
            if (matchCount >= 2) {
                categories.push(category);
            }
        }

        // Default category if nothing matches
        if (categories.length === 0) {
            categories.push('general');
        }

        return categories;
    }

    /**
     * Simple rule-based sentiment scoring.
     * Returns -1.0 (bearish) to 1.0 (bullish), 0 = neutral.
     */
    scoreSentiment(text: string): number {
        const lowerText = text.toLowerCase();

        const bullishWords = ['bullish', 'buy', 'long', 'breakout', 'pump', 'moon', 'accumulate',
            'uptrend', 'higher high', 'support', 'mua', 'tăng', 'tích cực', 'target',
            'ATH', 'rally', 'recovery', 'bounce', 'green', 'strong'];
        const bearishWords = ['bearish', 'sell', 'short', 'breakdown', 'dump', 'crash', 'distribute',
            'downtrend', 'lower low', 'resistance', 'bán', 'giảm', 'tiêu cực',
            'ATL', 'correction', 'drop', 'red', 'weak', 'fear'];

        let score = 0;
        bullishWords.forEach(w => { if (lowerText.includes(w)) score += 0.15; });
        bearishWords.forEach(w => { if (lowerText.includes(w)) score -= 0.15; });

        // Clamp to [-1, 1]
        return Math.max(-1, Math.min(1, Math.round(score * 100) / 100));
    }

    // --- CRUD Operations ---

    /**
     * Add a new research item with auto-tagging.
     */
    addItem(userId: number, content: string, sourceName?: string): ResearchItem {
        const items = this.getItems(userId);

        const newItem: ResearchItem = {
            id: this.generateId(),
            userId,
            content,
            sourceName,
            tickers: this.extractTickers(content),
            categories: this.classifyCategories(content),
            sentiment: this.scoreSentiment(content),
            isStarred: false,
            createdAt: new Date().toISOString(),
        };

        items.push(newItem);
        this.saveData();
        return newItem;
    }

    /**
     * Get all items for a user.
     */
    getItems(userId: number): ResearchItem[] {
        if (!this.research.has(userId)) {
            this.research.set(userId, []);
        }
        return this.research.get(userId)!;
    }

    /**
     * Get item by ID.
     */
    getItemById(userId: number, itemId: string): ResearchItem | undefined {
        return this.getItems(userId).find(i => i.id === itemId);
    }

    /**
     * Star/unstar an item. Returns the updated item or null if not found.
     */
    toggleStar(userId: number, itemId: string): ResearchItem | null {
        const item = this.getItemById(userId, itemId);
        if (item) {
            item.isStarred = !item.isStarred;
            this.saveData();
            return item;
        }
        return null;
    }

    /**
     * Star the most recent item for a user.
     */
    starLatest(userId: number): ResearchItem | null {
        const items = this.getItems(userId);
        if (items.length === 0) return null;
        const latest = items[items.length - 1];
        latest.isStarred = true;
        this.saveData();
        return latest;
    }

    /**
     * Search items by ticker symbol.
     */
    searchByTicker(userId: number, ticker: string): ResearchItem[] {
        const upperTicker = ticker.toUpperCase();
        return this.getItems(userId).filter(
            item => item.tickers.includes(upperTicker)
        );
    }

    /**
     * Search items by keyword (full-text search on content).
     */
    searchByKeyword(userId: number, keyword: string): ResearchItem[] {
        const lowerKeyword = keyword.toLowerCase();
        return this.getItems(userId).filter(
            item => item.content.toLowerCase().includes(lowerKeyword)
        );
    }

    /**
     * Search items by category.
     */
    searchByCategory(userId: number, category: string): ResearchItem[] {
        const lowerCat = category.toLowerCase();
        return this.getItems(userId).filter(
            item => item.categories.includes(lowerCat)
        );
    }

    /**
     * Get items from the last N hours (for digest).
     */
    getRecentItems(userId: number, hours: number = 24): ResearchItem[] {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        return this.getItems(userId).filter(item => item.createdAt >= cutoff);
    }

    /**
     * Get starred items.
     */
    getStarredItems(userId: number): ResearchItem[] {
        return this.getItems(userId).filter(item => item.isStarred);
    }

    /**
     * Get digest data: items grouped by ticker with counts.
     */
    getDigestData(userId: number, hours: number = 24): {
        totalItems: number;
        topTickers: { ticker: string; count: number; items: ResearchItem[] }[];
        uncategorized: ResearchItem[];
    } {
        const recentItems = this.getRecentItems(userId, hours);

        // Count by ticker
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

        // Sort by count descending
        const topTickers = Array.from(tickerMap.entries())
            .map(([ticker, items]) => ({ ticker, count: items.length, items }))
            .sort((a, b) => b.count - a.count);

        return {
            totalItems: recentItems.length,
            topTickers,
            uncategorized,
        };
    }

    /**
     * Get weekly report data: this week's activity vs the previous week,
     * with per-ticker sentiment shift. Used by the Weekly Report (Pro).
     */
    getWeeklyReportData(userId: number): {
        totalItems: number;        // last 7 days
        prevTotalItems: number;    // the 7 days before that
        topTickers: { ticker: string; count: number; items: ResearchItem[] }[];
        sentimentShifts: { ticker: string; thisAvg: number; prevAvg: number | null; shift: number | null; count: number }[];
    } {
        const now = Date.now();
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const weekAgo = new Date(now - weekMs).toISOString();
        const twoWeeksAgo = new Date(now - 2 * weekMs).toISOString();

        const items = this.getItems(userId);
        const thisWeek = items.filter((i) => i.createdAt >= weekAgo);
        const prevWeek = items.filter((i) => i.createdAt >= twoWeeksAgo && i.createdAt < weekAgo);

        const avgSentiment = (list: ResearchItem[]): number | null =>
            list.length === 0 ? null : Math.round((list.reduce((s, i) => s + i.sentiment, 0) / list.length) * 100) / 100;

        // Group this week's items by ticker (mirrors getDigestData).
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

        // Sentiment shift = this week's avg sentiment minus previous week's, per top ticker.
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

    /**
     * Get stats for a user.
     */
    getStats(userId: number): {
        totalItems: number;
        starredCount: number;
        topTickers: { ticker: string; count: number }[];
        todayCount: number;
        thisWeekCount: number;
    } {
        const items = this.getItems(userId);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Count tickers across all items
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
            starredCount: items.filter(i => i.isStarred).length,
            topTickers,
            todayCount: items.filter(i => i.createdAt >= todayStart).length,
            thisWeekCount: items.filter(i => i.createdAt >= weekStart).length,
        };
    }

    /**
     * Get count of items saved today (for rate limiting).
     */
    getTodayCount(userId: number): number {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        return this.getItems(userId).filter(i => i.createdAt >= todayStart).length;
    }

    /**
     * Get all user IDs that have research items (for digest cron).
     */
    getAllUserIds(): number[] {
        return Array.from(this.research.keys());
    }

    // --- Utility ---

    private generateId(): string {
        return `r_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }
}
