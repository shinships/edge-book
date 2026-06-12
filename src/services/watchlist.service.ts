import { db } from '../db';
import { watchlistItems } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

export class WatchlistService {
    private generateId(): string {
        return `w_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    async getWatchlist(userId: number): Promise<string[]> {
        const rows = await db.select()
            .from(watchlistItems)
            .where(eq(watchlistItems.userId, userId))
            .orderBy(desc(watchlistItems.createdAt));
        return rows.map((r) => r.ticker);
    }

    async count(userId: number): Promise<number> {
        return (await this.getWatchlist(userId)).length;
    }

    async add(userId: number, ticker: string): Promise<'added' | 'exists'> {
        const upper = ticker.toUpperCase();
        const inserted = await db.insert(watchlistItems).values({
            id: this.generateId(),
            userId,
            ticker: upper,
            createdAt: new Date(),
        }).onConflictDoNothing().returning();
        return inserted.length > 0 ? 'added' : 'exists';
    }

    async remove(userId: number, ticker: string): Promise<boolean> {
        const deleted = await db.delete(watchlistItems)
            .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.ticker, ticker.toUpperCase())))
            .returning();
        return deleted.length > 0;
    }
}
