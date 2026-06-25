import { db } from '../db';
import { portfolioPositions } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

// --- Interfaces ---

export type PositionMarket = 'vn' | 'crypto';

export interface Position {
    id: string;
    userId: number;
    ticker: string;
    quantity: number;
    avgCost: number;       // native price unit (VN: thousand VND, crypto: USD)
    market: PositionMarket;
    realizedPnl: number;   // cumulative booked profit, money units (qty * price)
    createdAt: string;
    updatedAt: string;
}

export interface PositionValuation extends Position {
    price?: number;            // current price, native unit (undefined if unavailable)
    cost: number;              // quantity * avgCost
    marketValue?: number;      // quantity * price
    unrealizedPnl?: number;    // marketValue - cost
    unrealizedPct?: number;    // unrealizedPnl / cost * 100
    weight?: number;           // % of its market's total market value
}

export interface MarketTotals {
    cost: number;
    marketValue: number;
    unrealizedPnl: number;
    realizedPnl: number;
    priced: boolean;           // false if any position lacked a live price
}

export interface PortfolioValuation {
    positions: PositionValuation[];
    byMarket: Partial<Record<PositionMarket, MarketTotals>>;
}

export interface SellResult {
    realized: number;          // money booked on this sell
    remaining: number;         // shares left after the sell
    avgCost: number;
    closed: boolean;           // true if the position was fully closed
}

type PositionRow = typeof portfolioPositions.$inferSelect;

function toPosition(row: PositionRow): Position {
    return {
        id: row.id,
        userId: row.userId,
        ticker: row.ticker,
        quantity: row.quantity,
        avgCost: row.avgCost,
        market: row.market as PositionMarket,
        realizedPnl: row.realizedPnl,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

const round = (n: number, d = 4) => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
};

// --- Service ---

export class PortfolioService {
    private generateId(): string {
        return `p_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    async getPositions(userId: number): Promise<Position[]> {
        const rows = await db.select()
            .from(portfolioPositions)
            .where(eq(portfolioPositions.userId, userId))
            .orderBy(desc(portfolioPositions.updatedAt));
        return rows.map(toPosition);
    }

    async getPosition(userId: number, ticker: string): Promise<Position | undefined> {
        const [row] = await db.select()
            .from(portfolioPositions)
            .where(and(eq(portfolioPositions.userId, userId), eq(portfolioPositions.ticker, ticker.toUpperCase())));
        return row ? toPosition(row) : undefined;
    }

    /** Buy / average-in. Weighted-average cost; creates the position if new. */
    async buy(
        userId: number,
        ticker: string,
        quantity: number,
        price: number,
        market: PositionMarket
    ): Promise<Position | null> {
        if (!Number.isFinite(quantity) || quantity <= 0) return null;
        if (!Number.isFinite(price) || price <= 0) return null;
        const upper = ticker.toUpperCase();
        const existing = await this.getPosition(userId, upper);
        const now = new Date();

        if (!existing) {
            const [row] = await db.insert(portfolioPositions).values({
                id: this.generateId(),
                userId,
                ticker: upper,
                quantity: round(quantity),
                avgCost: round(price),
                market,
                realizedPnl: 0,
                createdAt: now,
                updatedAt: now,
            }).returning();
            return toPosition(row!);
        }

        const newQty = existing.quantity + quantity;
        const newAvg = (existing.quantity * existing.avgCost + quantity * price) / newQty;
        const [row] = await db.update(portfolioPositions)
            .set({ quantity: round(newQty), avgCost: round(newAvg), updatedAt: now })
            .where(eq(portfolioPositions.id, existing.id))
            .returning();
        return toPosition(row!);
    }

    /** Sell / reduce. Books realized PnL at avgCost; fully closes (deletes) at zero. */
    async sell(
        userId: number,
        ticker: string,
        quantity: number,
        price: number
    ): Promise<SellResult | null> {
        if (!Number.isFinite(quantity) || quantity <= 0) return null;
        if (!Number.isFinite(price) || price <= 0) return null;
        const existing = await this.getPosition(userId, ticker.toUpperCase());
        if (!existing) return null;

        const sellQty = Math.min(quantity, existing.quantity);
        const realized = round(sellQty * (price - existing.avgCost), 2);
        const remaining = round(existing.quantity - sellQty);
        const now = new Date();

        if (remaining <= 0) {
            await db.delete(portfolioPositions).where(eq(portfolioPositions.id, existing.id));
            return { realized, remaining: 0, avgCost: existing.avgCost, closed: true };
        }

        await db.update(portfolioPositions)
            .set({
                quantity: remaining,
                realizedPnl: round(existing.realizedPnl + realized, 2),
                updatedAt: now,
            })
            .where(eq(portfolioPositions.id, existing.id));
        return { realized, remaining, avgCost: existing.avgCost, closed: false };
    }

    /**
     * Value the portfolio against a price map (ticker -> current native price), typically
     * from MarketRouter.getPrices(). Pure aggregation — no network. Totals are computed
     * per market (VN thousand-VND vs crypto USD are not summed across currencies).
     */
    async valuate(userId: number, prices: Map<string, number>): Promise<PortfolioValuation> {
        const positions = await this.getPositions(userId);
        const byMarket: Partial<Record<PositionMarket, MarketTotals>> = {};

        const valuations: PositionValuation[] = positions.map((p) => {
            const cost = round(p.quantity * p.avgCost, 2);
            const price = prices.get(p.ticker);
            const v: PositionValuation = { ...p, cost };
            if (price !== undefined) {
                const marketValue = round(p.quantity * price, 2);
                v.price = price;
                v.marketValue = marketValue;
                v.unrealizedPnl = round(marketValue - cost, 2);
                v.unrealizedPct = cost > 0 ? round((v.unrealizedPnl / cost) * 100, 2) : 0;
            }
            const t = (byMarket[p.market] ??= { cost: 0, marketValue: 0, unrealizedPnl: 0, realizedPnl: 0, priced: true });
            t.cost = round(t.cost + cost, 2);
            t.realizedPnl = round(t.realizedPnl + p.realizedPnl, 2);
            if (v.marketValue !== undefined) {
                t.marketValue = round(t.marketValue + v.marketValue, 2);
                t.unrealizedPnl = round(t.unrealizedPnl + (v.unrealizedPnl ?? 0), 2);
            } else {
                t.priced = false;
            }
            return v;
        });

        // Weight = position value within its market's total market value.
        for (const v of valuations) {
            const tot = byMarket[v.market];
            if (v.marketValue !== undefined && tot && tot.marketValue > 0) {
                v.weight = round((v.marketValue / tot.marketValue) * 100, 1);
            }
        }

        return { positions: valuations, byMarket };
    }
}
