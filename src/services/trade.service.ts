import * as fs from 'fs';
import * as path from 'path';

// --- Interfaces ---

export interface TradeItem {
    id: string;
    userId: number;
    ticker: string;            // 'BTC'
    direction: 'long' | 'short';
    entryPrice: number;
    stopLoss?: number;
    takeProfit?: number;
    exitPrice?: number;
    pnlPercent?: number;       // computed on close
    status: 'open' | 'closed';
    notes?: string;
    openedAt: string;          // ISO
    closedAt?: string;         // ISO
}

export interface UserTrades {
    userId: number;
    items: TradeItem[];
}

export interface TradeStats {
    total: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    winRate: number;           // 0-100
    totalPnl: number;          // sum of pnlPercent (closed)
    avgRR: number;             // average planned reward/risk
    best?: TradeItem;
    worst?: TradeItem;
}

// --- Service ---

export class TradeService {
    private dataPath: string;
    private trades: Map<number, TradeItem[]>;

    constructor() {
        this.dataPath = path.resolve(__dirname, '../../data/trades.json');
        this.trades = new Map();
        this.loadData();
    }

    // --- Persistence ---

    private loadData() {
        if (fs.existsSync(this.dataPath)) {
            try {
                const rawData = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(rawData);
                if (Array.isArray(parsed)) {
                    parsed.forEach((u: UserTrades) => this.trades.set(u.userId, u.items));
                }
            } catch (error) {
                console.error('Error loading trade data:', error);
            }
        }
    }

    private saveData() {
        try {
            const data: UserTrades[] = Array.from(this.trades.entries()).map(([userId, items]) => ({
                userId,
                items,
            }));
            // Ensure data directory exists
            const dir = path.dirname(this.dataPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Atomic write: write to a temp file then rename, so a crash mid-write
            // can't truncate the existing journal. (Does not guard against multiple
            // concurrent bot instances — that requires a real DB; run one instance.)
            const tmp = `${this.dataPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, this.dataPath);
        } catch (error) {
            console.error('Error saving trade data:', error);
        }
    }

    private generateId(): string {
        return `t_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    // --- Accessors ---

    getTrades(userId: number): TradeItem[] {
        if (!this.trades.has(userId)) {
            this.trades.set(userId, []);
        }
        return this.trades.get(userId)!;
    }

    getOpenTrades(userId: number): TradeItem[] {
        return this.getTrades(userId).filter((t) => t.status === 'open');
    }

    getClosedTrades(userId: number): TradeItem[] {
        return this.getTrades(userId).filter((t) => t.status === 'closed');
    }

    // --- Mutations ---

    openTrade(
        userId: number,
        data: {
            ticker: string;
            direction: 'long' | 'short';
            entryPrice: number;
            stopLoss?: number;
            takeProfit?: number;
            notes?: string;
        }
    ): TradeItem | null {
        // Reject invalid prices to avoid NaN/Infinity poisoning PnL & stats later.
        if (!Number.isFinite(data.entryPrice) || data.entryPrice <= 0) return null;
        if (data.stopLoss !== undefined && (!Number.isFinite(data.stopLoss) || data.stopLoss <= 0)) return null;
        if (data.takeProfit !== undefined && (!Number.isFinite(data.takeProfit) || data.takeProfit <= 0)) return null;
        const items = this.getTrades(userId);
        const trade: TradeItem = {
            id: this.generateId(),
            userId,
            ticker: data.ticker.toUpperCase(),
            direction: data.direction,
            entryPrice: data.entryPrice,
            stopLoss: data.stopLoss,
            takeProfit: data.takeProfit,
            status: 'open',
            notes: data.notes,
            openedAt: new Date().toISOString(),
        };
        items.push(trade);
        this.saveData();
        return trade;
    }

    /**
     * Close the most-recent OPEN trade for a ticker.
     * Provide either an absolute exit `price` or a `percent` PnL directly.
     */
    closeTrade(
        userId: number,
        ticker: string,
        exit: { price?: number; percent?: number }
    ): TradeItem | null {
        const items = this.getTrades(userId);
        const upper = ticker.toUpperCase();
        // Most recent open trade for this ticker
        const trade = [...items]
            .reverse()
            .find((t) => t.status === 'open' && t.ticker === upper);
        if (!trade) return null;

        let pnl: number;
        if (typeof exit.percent === 'number') {
            if (!Number.isFinite(exit.percent)) return null;
            pnl = exit.percent;
            // exitPrice derived from entry + pnl for record-keeping
            trade.exitPrice =
                trade.direction === 'long'
                    ? trade.entryPrice * (1 + pnl / 100)
                    : trade.entryPrice * (1 - pnl / 100);
        } else if (typeof exit.price === 'number') {
            if (!Number.isFinite(exit.price) || exit.price <= 0) return null;
            trade.exitPrice = exit.price;
            const raw = ((exit.price - trade.entryPrice) / trade.entryPrice) * 100;
            pnl = trade.direction === 'long' ? raw : -raw;
        } else {
            return null;
        }

        trade.pnlPercent = Math.round(pnl * 100) / 100;
        trade.status = 'closed';
        trade.closedAt = new Date().toISOString();
        this.saveData();
        return trade;
    }

    // --- Stats ---

    /**
     * Planned reward/risk from TP/SL relative to entry, direction-aware.
     * Returns null if TP/SL missing or the setup is reversed-logic
     * (e.g. a long with TP below entry), so RR isn't computed for invalid setups.
     */
    private plannedRR(t: TradeItem): number | null {
        if (t.takeProfit === undefined || t.stopLoss === undefined) return null;
        let reward: number;
        let risk: number;
        if (t.direction === 'long') {
            reward = t.takeProfit - t.entryPrice;
            risk = t.entryPrice - t.stopLoss;
        } else {
            reward = t.entryPrice - t.takeProfit;
            risk = t.stopLoss - t.entryPrice;
        }
        if (reward <= 0 || risk <= 0) return null;
        return reward / risk;
    }

    getStats(userId: number): TradeStats {
        const all = this.getTrades(userId);
        const closed = all.filter((t) => t.status === 'closed');
        const wins = closed.filter((t) => (t.pnlPercent ?? 0) > 0);
        const losses = closed.filter((t) => (t.pnlPercent ?? 0) <= 0);

        const totalPnl =
            Math.round(closed.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0) * 100) / 100;

        const rrValues = all
            .map((t) => this.plannedRR(t))
            .filter((v): v is number => v !== null);
        const avgRR =
            rrValues.length > 0
                ? Math.round((rrValues.reduce((a, b) => a + b, 0) / rrValues.length) * 100) / 100
                : 0;

        let best: TradeItem | undefined;
        let worst: TradeItem | undefined;
        for (const t of closed) {
            if (best === undefined || (t.pnlPercent ?? 0) > (best.pnlPercent ?? 0)) best = t;
            if (worst === undefined || (t.pnlPercent ?? 0) < (worst.pnlPercent ?? 0)) worst = t;
        }

        return {
            total: all.length,
            open: all.length - closed.length,
            closed: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 1000) / 10 : 0,
            totalPnl,
            avgRR,
            best,
            worst,
        };
    }
}
