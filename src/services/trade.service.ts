import { db } from '../db';
import { trades } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

// --- Interfaces ---

export interface TradeItem {
    id: string;
    userId: number;
    ticker: string;
    direction: 'long' | 'short';
    entryPrice: number;
    stopLoss?: number;
    takeProfit?: number;
    exitPrice?: number;
    pnlPercent?: number;
    status: 'open' | 'closed';
    notes?: string;
    linkedResearch?: string[];
    positionSize?: number;
    riskPercent?: number;
    feePercent?: number;
    closeReason?: 'tp' | 'sl' | 'manual';
    setupTag?: string;
    openedAt: string;
    closedAt?: string;
}

export interface TradeStats {
    total: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgRR: number;
    totalR: number;
    avgR: number | null;
    rTradeCount: number;
    best?: TradeItem;
    worst?: TradeItem;
}

export interface TickerPerf {
    ticker: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
}

export interface DirectionPerf {
    direction: 'long' | 'short';
    trades: number;
    wins: number;
    winRate: number;
    totalPnl: number;
}

export interface MonthPerf {
    month: string;
    trades: number;
    totalPnl: number;
    winRate: number;
}

export interface TradeAnalytics {
    closedCount: number;
    byTicker: TickerPerf[];
    byDirection: DirectionPerf[];
    byMonth: MonthPerf[];
    avgHoldHours: number | null;
    bestTicker?: TickerPerf;
    worstTicker?: TickerPerf;
}

type TradeRow = typeof trades.$inferSelect;

function toItem(row: TradeRow): TradeItem {
    return {
        id: row.id,
        userId: row.userId,
        ticker: row.ticker,
        direction: row.direction as 'long' | 'short',
        entryPrice: row.entryPrice,
        stopLoss: row.stopLoss ?? undefined,
        takeProfit: row.takeProfit ?? undefined,
        exitPrice: row.exitPrice ?? undefined,
        pnlPercent: row.pnlPercent ?? undefined,
        status: row.status as 'open' | 'closed',
        notes: row.notes ?? undefined,
        linkedResearch: row.linkedResearch ?? [],
        positionSize: row.positionSize ?? undefined,
        riskPercent: row.riskPercent ?? undefined,
        feePercent: row.feePercent ?? undefined,
        closeReason: (row.closeReason as 'tp' | 'sl' | 'manual') ?? undefined,
        setupTag: row.setupTag ?? undefined,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt?.toISOString(),
    };
}

// --- Service ---

export class TradeService {
    private generateId(): string {
        return `t_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    async getTrades(userId: number): Promise<TradeItem[]> {
        const rows = await db.select()
            .from(trades)
            .where(eq(trades.userId, userId))
            .orderBy(trades.openedAt);
        return rows.map(toItem);
    }

    async getOpenTrades(userId: number): Promise<TradeItem[]> {
        const rows = await db.select()
            .from(trades)
            .where(and(eq(trades.userId, userId), eq(trades.status, 'open')))
            .orderBy(trades.openedAt);
        return rows.map(toItem);
    }

    async getClosedTrades(userId: number): Promise<TradeItem[]> {
        const rows = await db.select()
            .from(trades)
            .where(and(eq(trades.userId, userId), eq(trades.status, 'closed')))
            .orderBy(trades.openedAt);
        return rows.map(toItem);
    }

    async getTradeById(userId: number, tradeId: string): Promise<TradeItem | undefined> {
        const [row] = await db.select()
            .from(trades)
            .where(and(eq(trades.id, tradeId), eq(trades.userId, userId)));
        return row ? toItem(row) : undefined;
    }

    async linkResearch(userId: number, tradeId: string, researchId: string): Promise<TradeItem | null> {
        const [row] = await db.select()
            .from(trades)
            .where(and(eq(trades.id, tradeId), eq(trades.userId, userId)));
        if (!row) return null;

        const linked = row.linkedResearch ?? [];
        if (linked.includes(researchId)) return toItem(row);

        const [updated] = await db.update(trades)
            .set({ linkedResearch: [...linked, researchId] })
            .where(eq(trades.id, tradeId))
            .returning();
        return toItem(updated!);
    }

    async openTrade(
        userId: number,
        data: {
            ticker: string;
            direction: 'long' | 'short';
            entryPrice: number;
            stopLoss?: number;
            takeProfit?: number;
            notes?: string;
            positionSize?: number;
            riskPercent?: number;
            feePercent?: number;
            setupTag?: string;
        }
    ): Promise<TradeItem | null> {
        if (!Number.isFinite(data.entryPrice) || data.entryPrice <= 0) return null;
        if (data.stopLoss !== undefined && (!Number.isFinite(data.stopLoss) || data.stopLoss <= 0)) return null;
        if (data.takeProfit !== undefined && (!Number.isFinite(data.takeProfit) || data.takeProfit <= 0)) return null;
        if (data.positionSize !== undefined && (!Number.isFinite(data.positionSize) || data.positionSize <= 0)) return null;
        if (data.riskPercent !== undefined && (!Number.isFinite(data.riskPercent) || data.riskPercent <= 0 || data.riskPercent > 100)) return null;
        if (data.feePercent !== undefined && (!Number.isFinite(data.feePercent) || data.feePercent < 0 || data.feePercent >= 100)) return null;

        const setupTag = data.setupTag?.trim().toLowerCase().slice(0, 24) || undefined;

        const [row] = await db.insert(trades).values({
            id: this.generateId(),
            userId,
            ticker: data.ticker.toUpperCase(),
            direction: data.direction,
            entryPrice: data.entryPrice,
            stopLoss: data.stopLoss,
            takeProfit: data.takeProfit,
            status: 'open',
            notes: data.notes,
            linkedResearch: [],
            positionSize: data.positionSize,
            riskPercent: data.riskPercent,
            feePercent: data.feePercent,
            setupTag,
            openedAt: new Date(),
        }).returning();
        return toItem(row!);
    }

    async closeTrade(
        userId: number,
        ticker: string,
        exit: { price?: number; percent?: number },
        explicitReason?: 'tp' | 'sl' | 'manual'
    ): Promise<TradeItem | null> {
        const upper = ticker.toUpperCase();
        const [row] = await db.select()
            .from(trades)
            .where(and(
                eq(trades.userId, userId),
                eq(trades.ticker, upper),
                eq(trades.status, 'open')
            ))
            .orderBy(desc(trades.openedAt))
            .limit(1);
        if (!row) return null;

        const trade = toItem(row);
        let pnl: number;
        let exitPrice: number;

        if (typeof exit.percent === 'number') {
            if (!Number.isFinite(exit.percent)) return null;
            pnl = exit.percent;
            exitPrice = trade.direction === 'long'
                ? trade.entryPrice * (1 + pnl / 100)
                : trade.entryPrice * (1 - pnl / 100);
        } else if (typeof exit.price === 'number') {
            if (!Number.isFinite(exit.price) || exit.price <= 0) return null;
            exitPrice = exit.price;
            const raw = ((exit.price - trade.entryPrice) / trade.entryPrice) * 100;
            pnl = trade.direction === 'long' ? raw : -raw;
        } else {
            return null;
        }

        const pnlPercent = Math.round(pnl * 100) / 100;

        // Infer close reason from exit vs SL/TP when not explicitly given.
        let closeReason: 'tp' | 'sl' | 'manual' = explicitReason ?? 'manual';
        if (!explicitReason) {
            if (trade.direction === 'long') {
                if (trade.takeProfit !== undefined && exitPrice >= trade.takeProfit) closeReason = 'tp';
                else if (trade.stopLoss !== undefined && exitPrice <= trade.stopLoss) closeReason = 'sl';
            } else {
                if (trade.takeProfit !== undefined && exitPrice <= trade.takeProfit) closeReason = 'tp';
                else if (trade.stopLoss !== undefined && exitPrice >= trade.stopLoss) closeReason = 'sl';
            }
        }

        const [updated] = await db.update(trades)
            .set({ status: 'closed', exitPrice, pnlPercent, closeReason, closedAt: new Date() })
            .where(eq(trades.id, trade.id))
            .returning();
        return toItem(updated!);
    }

    // Risk per trade as % of entry, derived from the stop distance. Null without SL.
    riskPerTradePercent(t: TradeItem): number | null {
        if (t.stopLoss === undefined) return null;
        const risk = (Math.abs(t.entryPrice - t.stopLoss) / t.entryPrice) * 100;
        return risk > 0 ? risk : null;
    }

    // Actual R-multiple of a closed trade: net PnL% (gross minus fee) / risk-per-trade%.
    // Null when there is no SL or the trade is not closed yet.
    actualR(t: TradeItem): number | null {
        const risk = this.riskPerTradePercent(t);
        if (risk === null || t.pnlPercent === undefined) return null;
        const net = t.pnlPercent - (t.feePercent ?? 0);
        return Math.round((net / risk) * 100) / 100;
    }

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

    async getStats(userId: number): Promise<TradeStats> {
        const all = await this.getTrades(userId);
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

        const rValues = closed
            .map((t) => this.actualR(t))
            .filter((v): v is number => v !== null);
        const totalR = Math.round(rValues.reduce((a, b) => a + b, 0) * 100) / 100;
        const avgR =
            rValues.length > 0
                ? Math.round((totalR / rValues.length) * 100) / 100
                : null;

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
            totalR,
            avgR,
            rTradeCount: rValues.length,
            best,
            worst,
        };
    }

    // Cumulative R curve over closed trades that have a stop (R-eligible), oldest first.
    async getEquityCurve(userId: number): Promise<{
        points: { closedAt: string; ticker: string; r: number; cumR: number }[];
        totalR: number;
        maxCumR: number;
        minCumR: number;
        skipped: number;
    }> {
        const closed = (await this.getClosedTrades(userId))
            .filter((t) => t.closedAt)
            .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

        const points: { closedAt: string; ticker: string; r: number; cumR: number }[] = [];
        let cumR = 0;
        let skipped = 0;
        for (const t of closed) {
            const r = this.actualR(t);
            if (r === null) {
                skipped++;
                continue;
            }
            cumR = Math.round((cumR + r) * 100) / 100;
            points.push({ closedAt: t.closedAt!, ticker: t.ticker, r, cumR });
        }

        const cumValues = points.map((p) => p.cumR);
        return {
            points,
            totalR: points.length > 0 ? cumValues[cumValues.length - 1] : 0,
            maxCumR: cumValues.length > 0 ? Math.max(...cumValues) : 0,
            minCumR: cumValues.length > 0 ? Math.min(...cumValues) : 0,
            skipped,
        };
    }

    async getAnalytics(userId: number): Promise<TradeAnalytics> {
        const closed = await this.getClosedTrades(userId);

        const round2 = (n: number) => Math.round(n * 100) / 100;
        const winRate = (wins: number, total: number) =>
            total > 0 ? Math.round((wins / total) * 1000) / 10 : 0;

        const tickerMap = new Map<string, TradeItem[]>();
        for (const t of closed) {
            if (!tickerMap.has(t.ticker)) tickerMap.set(t.ticker, []);
            tickerMap.get(t.ticker)!.push(t);
        }
        const byTicker: TickerPerf[] = Array.from(tickerMap.entries())
            .map(([ticker, items]) => {
                const wins = items.filter((t) => (t.pnlPercent ?? 0) > 0).length;
                const totalPnl = round2(items.reduce((s, t) => s + (t.pnlPercent ?? 0), 0));
                return {
                    ticker,
                    trades: items.length,
                    wins,
                    losses: items.length - wins,
                    winRate: winRate(wins, items.length),
                    totalPnl,
                    avgPnl: round2(totalPnl / items.length),
                };
            })
            .sort((a, b) => b.totalPnl - a.totalPnl);

        const byDirection: DirectionPerf[] = (['long', 'short'] as const)
            .map((direction) => {
                const items = closed.filter((t) => t.direction === direction);
                const wins = items.filter((t) => (t.pnlPercent ?? 0) > 0).length;
                return {
                    direction,
                    trades: items.length,
                    wins,
                    winRate: winRate(wins, items.length),
                    totalPnl: round2(items.reduce((s, t) => s + (t.pnlPercent ?? 0), 0)),
                };
            })
            .filter((d) => d.trades > 0);

        const monthMap = new Map<string, TradeItem[]>();
        for (const t of closed) {
            const month = (t.closedAt ?? t.openedAt).slice(0, 7);
            if (!monthMap.has(month)) monthMap.set(month, []);
            monthMap.get(month)!.push(t);
        }
        const byMonth: MonthPerf[] = Array.from(monthMap.entries())
            .map(([month, items]) => {
                const wins = items.filter((t) => (t.pnlPercent ?? 0) > 0).length;
                return {
                    month,
                    trades: items.length,
                    totalPnl: round2(items.reduce((s, t) => s + (t.pnlPercent ?? 0), 0)),
                    winRate: winRate(wins, items.length),
                };
            })
            .sort((a, b) => a.month.localeCompare(b.month));

        const holdHours = closed
            .filter((t) => t.closedAt)
            .map((t) => (new Date(t.closedAt!).getTime() - new Date(t.openedAt).getTime()) / 3_600_000)
            .filter((h) => Number.isFinite(h) && h >= 0);
        const avgHoldHours =
            holdHours.length > 0
                ? round2(holdHours.reduce((a, b) => a + b, 0) / holdHours.length)
                : null;

        return {
            closedCount: closed.length,
            byTicker,
            byDirection,
            byMonth,
            avgHoldHours,
            bestTicker: byTicker[0],
            worstTicker: byTicker.length > 0 ? byTicker[byTicker.length - 1] : undefined,
        };
    }
}
