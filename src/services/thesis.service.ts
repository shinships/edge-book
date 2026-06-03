import { db } from '../db';
import { theses } from '../db/schema';
import { eq, and } from 'drizzle-orm';

// --- Interfaces ---

export type Stance = 'bullish' | 'bearish';

export interface ThesisItem {
    id: string;
    userId: number;
    ticker: string;
    stance: Stance;
    text: string;
    status: 'active' | 'closed';
    conflictCount: number;
    createdAt: string;
    closedAt?: string;
}

const CONFLICT_THRESHOLD = 0.2;

type ThesisRow = typeof theses.$inferSelect;

function toItem(row: ThesisRow): ThesisItem {
    return {
        id: row.id,
        userId: row.userId,
        ticker: row.ticker,
        stance: row.stance as Stance,
        text: row.thesisText,
        status: row.status as 'active' | 'closed',
        conflictCount: row.conflictCount,
        createdAt: row.createdAt.toISOString(),
        closedAt: row.closedAt?.toISOString(),
    };
}

// --- Service ---

export class ThesisService {
    private generateId(): string {
        return `th_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    async getTheses(userId: number): Promise<ThesisItem[]> {
        const rows = await db.select()
            .from(theses)
            .where(eq(theses.userId, userId))
            .orderBy(theses.createdAt);
        return rows.map(toItem);
    }

    async getActiveTheses(userId: number): Promise<ThesisItem[]> {
        const rows = await db.select()
            .from(theses)
            .where(and(eq(theses.userId, userId), eq(theses.status, 'active')))
            .orderBy(theses.createdAt);
        return rows.map(toItem);
    }

    async addThesis(userId: number, ticker: string, stance: Stance, text: string): Promise<ThesisItem> {
        const [row] = await db.insert(theses).values({
            id: this.generateId(),
            userId,
            ticker: ticker.toUpperCase(),
            stance,
            thesisText: text.trim(),
            status: 'active',
            conflictCount: 0,
            createdAt: new Date(),
        }).returning();
        return toItem(row!);
    }

    async closeThesis(userId: number, selector: string): Promise<ThesisItem | null> {
        const active = await this.getActiveTheses(userId);
        if (active.length === 0) return null;

        let target: ThesisItem | undefined;
        if (/^\d+$/.test(selector)) {
            const idx = parseInt(selector, 10) - 1;
            target = active[idx];
        } else {
            const upper = selector.toUpperCase();
            target = [...active].reverse().find((t) => t.ticker === upper);
        }
        if (!target) return null;

        const [updated] = await db.update(theses)
            .set({ status: 'closed', closedAt: new Date() })
            .where(eq(theses.id, target.id))
            .returning();
        return toItem(updated!);
    }

    async findConflicts(userId: number, ticker: string, sentiment: number): Promise<ThesisItem[]> {
        const upper = ticker.toUpperCase();
        const active = await this.getActiveTheses(userId);

        const conflicts = active.filter((t) => {
            if (t.ticker !== upper) return false;
            return t.stance === 'bullish'
                ? sentiment <= -CONFLICT_THRESHOLD
                : sentiment >= CONFLICT_THRESHOLD;
        });

        if (conflicts.length > 0) {
            await Promise.all(
                conflicts.map((t) =>
                    db.update(theses)
                        .set({ conflictCount: t.conflictCount + 1 })
                        .where(eq(theses.id, t.id))
                )
            );
            conflicts.forEach((t) => { t.conflictCount++; });
        }

        return conflicts;
    }
}
