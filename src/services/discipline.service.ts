import { db } from '../db';
import { disciplineState } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface DisciplineStateItem {
    userId: number;
    enabled: boolean;
    lossStreak: number;
    lossDate?: string;
    lossesToday: number;
    dailyLossLimit: number;
    cooldownUntil?: string;
}

export interface LossResult {
    lossStreak: number;
    lossesToday: number;
    dailyLossLimit: number;
    limitHit: boolean;
}

type StateRow = typeof disciplineState.$inferSelect;

function toItem(row: StateRow): DisciplineStateItem {
    return {
        userId: row.userId,
        enabled: row.enabled,
        lossStreak: row.lossStreak,
        lossDate: row.lossDate ?? undefined,
        lossesToday: row.lossesToday,
        dailyLossLimit: row.dailyLossLimit,
        cooldownUntil: row.cooldownUntil?.toISOString(),
    };
}

const VN_TZ = 'Asia/Ho_Chi_Minh';

// Today's date string in VN timezone, e.g. "2026-06-13" (en-CA locale gives ISO order).
function vnToday(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: VN_TZ });
}

// End of the current VN day as a Date. VN has no DST and is fixed UTC+7,
// so "next VN midnight" = (VN date + 1 day) at 00:00 minus the +7h offset.
function vnEndOfDay(): Date {
    return new Date(`${vnToday()}T23:59:59+07:00`);
}

export class DisciplineService {
    // Fetch the user's state, creating the default row (enabled, limit 3) on first touch.
    async getState(userId: number): Promise<DisciplineStateItem> {
        await db.insert(disciplineState).values({ userId }).onConflictDoNothing();
        const [row] = await db.select().from(disciplineState).where(eq(disciplineState.userId, userId));
        const item = toItem(row!);

        // Stale daily loss counter from a previous VN day resets lazily on read.
        if (item.lossDate && item.lossDate !== vnToday() && item.lossesToday > 0) {
            const [updated] = await db.update(disciplineState)
                .set({ lossesToday: 0, lossDate: vnToday() })
                .where(eq(disciplineState.userId, userId))
                .returning();
            return toItem(updated!);
        }
        return item;
    }

    async setEnabled(userId: number, enabled: boolean): Promise<void> {
        await this.getState(userId);
        await db.update(disciplineState)
            .set({ enabled })
            .where(eq(disciplineState.userId, userId));
    }

    async setDailyLossLimit(userId: number, limit: number): Promise<void> {
        await this.getState(userId);
        await db.update(disciplineState)
            .set({ dailyLossLimit: limit })
            .where(eq(disciplineState.userId, userId));
    }

    // Active cooldown end, or null when not in cooldown.
    async inCooldown(userId: number): Promise<Date | null> {
        const state = await this.getState(userId);
        if (!state.cooldownUntil) return null;
        const until = new Date(state.cooldownUntil);
        return until.getTime() > Date.now() ? until : null;
    }

    // Record a losing close: bump the streak and today's loss count; when the
    // daily limit is reached, lock Trade: until the end of the VN day.
    async recordLoss(userId: number): Promise<LossResult> {
        const state = await this.getState(userId);
        const today = vnToday();
        const lossesToday = (state.lossDate === today ? state.lossesToday : 0) + 1;
        const lossStreak = state.lossStreak + 1;
        const limitHit = lossesToday >= state.dailyLossLimit;

        await db.update(disciplineState)
            .set({
                lossStreak,
                lossesToday,
                lossDate: today,
                ...(limitHit ? { cooldownUntil: vnEndOfDay() } : {}),
            })
            .where(eq(disciplineState.userId, userId));

        return { lossStreak, lossesToday, dailyLossLimit: state.dailyLossLimit, limitHit };
    }

    // Record a winning close: the loss streak resets, daily counter stays.
    async recordWin(userId: number): Promise<void> {
        await this.getState(userId);
        await db.update(disciplineState)
            .set({ lossStreak: 0 })
            .where(eq(disciplineState.userId, userId));
    }
}
