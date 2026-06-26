import { db } from '../db';
import { alerts } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';

export type AlertType = 'price' | 'foreign' | 'proprietary' | 'volume' | 'rsi' | 'macross';

export interface AlertItem {
    id: string;
    userId: number;
    ticker: string;
    condition: 'above' | 'below';
    targetPrice: number;
    alertType: AlertType;
    params?: Record<string, any>;
    status: 'active' | 'triggered';
    createdAt: string;
    triggeredAt?: string;
}

type AlertRow = typeof alerts.$inferSelect;

function toItem(row: AlertRow): AlertItem {
    return {
        id: row.id,
        userId: row.userId,
        ticker: row.ticker,
        condition: row.condition as 'above' | 'below',
        targetPrice: row.targetPrice,
        alertType: (row.alertType as AlertType) ?? 'price',
        params: row.params ?? undefined,
        status: row.status as 'active' | 'triggered',
        createdAt: row.createdAt.toISOString(),
        triggeredAt: row.triggeredAt?.toISOString(),
    };
}

export class AlertService {
    private generateId(): string {
        return `a_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    async addAlert(
        userId: number,
        ticker: string,
        condition: 'above' | 'below',
        targetPrice: number,
        alertType: AlertType = 'price',
        params?: Record<string, any>
    ): Promise<AlertItem | null> {
        // Price/volume/rsi carry a positive threshold; foreign/macross use targetPrice=0.
        if (!Number.isFinite(targetPrice) || targetPrice < 0) return null;
        if (alertType === 'price' && targetPrice <= 0) return null;
        const [row] = await db.insert(alerts).values({
            id: this.generateId(),
            userId,
            ticker: ticker.toUpperCase(),
            condition,
            targetPrice,
            alertType,
            params,
            status: 'active',
            createdAt: new Date(),
        }).returning();
        return toItem(row!);
    }

    async getActiveAlerts(userId: number): Promise<AlertItem[]> {
        const rows = await db.select()
            .from(alerts)
            .where(and(eq(alerts.userId, userId), eq(alerts.status, 'active')))
            .orderBy(desc(alerts.createdAt));
        return rows.map(toItem);
    }

    async countActive(userId: number): Promise<number> {
        return (await this.getActiveAlerts(userId)).length;
    }

    async getAllActive(): Promise<AlertItem[]> {
        const rows = await db.select()
            .from(alerts)
            .where(eq(alerts.status, 'active'));
        return rows.map(toItem);
    }

    async getAlertById(userId: number, id: string): Promise<AlertItem | undefined> {
        const [row] = await db.select()
            .from(alerts)
            .where(and(eq(alerts.id, id), eq(alerts.userId, userId)));
        return row ? toItem(row) : undefined;
    }

    async deleteAlert(userId: number, id: string): Promise<boolean> {
        const deleted = await db.delete(alerts)
            .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
            .returning();
        return deleted.length > 0;
    }

    async markTriggered(id: string): Promise<void> {
        await db.update(alerts)
            .set({ status: 'triggered', triggeredAt: new Date() })
            .where(eq(alerts.id, id));
    }
}
