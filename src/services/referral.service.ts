import { db } from '../db';
import { referrals } from '../db/schema';
import { and, eq } from 'drizzle-orm';

export interface ReferralReward {
    referrerId: number;
    referrerRewardedCount: number;
}

export class ReferralService {
    // Record a pending referral for a brand-new user who arrived via
    // ?start=ref_<referrerId>. refereeId is unique, so only the first
    // referral link a user ever opens is recorded.
    async record(referrerId: number, refereeId: number): Promise<void> {
        if (referrerId === refereeId) return;
        await db.insert(referrals).values({
            id: `ref_${refereeId}`,
            referrerId,
            refereeId,
            status: 'pending',
            createdAt: new Date(),
        }).onConflictDoNothing();
    }

    async hasPending(refereeId: number): Promise<boolean> {
        const [row] = await db.select({ id: referrals.id }).from(referrals)
            .where(and(eq(referrals.refereeId, refereeId), eq(referrals.status, 'pending')));
        return !!row;
    }

    // Marks a referee's referral as rewarded (activation reached) and returns
    // the referrer + their updated successful-referral count. Returns null if
    // this user has no pending referral (not referred, or already rewarded).
    async reward(refereeId: number): Promise<ReferralReward | null> {
        const [row] = await db.select().from(referrals)
            .where(and(eq(referrals.refereeId, refereeId), eq(referrals.status, 'pending')));
        if (!row) return null;

        await db.update(referrals)
            .set({ status: 'rewarded', rewardedAt: new Date() })
            .where(eq(referrals.id, row.id));

        const referrerRewardedCount = await this.getRewardedCount(row.referrerId);
        return { referrerId: row.referrerId, referrerRewardedCount };
    }

    async getRewardedCount(referrerId: number): Promise<number> {
        const rows = await db.select({ id: referrals.id }).from(referrals)
            .where(and(eq(referrals.referrerId, referrerId), eq(referrals.status, 'rewarded')));
        return rows.length;
    }
}
