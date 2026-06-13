import { db } from '../db';
import { users, researchItems, plans, referrals } from '../db/schema';
import { inArray, ne, eq } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrowthSourceStats {
    source: string;
    users: number;
    paying: number;
}

export interface GrowthStats {
    totalUsers: number;
    newUsers7d: number;
    newBySource: GrowthSourceStats[];
    activatedCount: number;
    activationCohort: number;
    activationRate: number | null;
    w2RetainedCount: number;
    w2Cohort: number;
    w2RetentionRate: number | null;
    payingTotal: number;
    payingBySource: GrowthSourceStats[];
    referralCount: number;
    kFactor: number | null;
}

export class GrowthService {
    async getStats(): Promise<GrowthStats> {
        const now = Date.now();

        const allUsers = await db.select({
            id: users.id,
            source: users.acquisitionSource,
            createdAt: users.createdAt,
        }).from(users);

        const payingRows = await db.select({ userId: plans.userId })
            .from(plans)
            .where(ne(plans.tier, 'free'));
        const payingSet = new Set(payingRows.map((r) => r.userId));

        const bySource = (list: { id: number; source: string | null }[]): GrowthSourceStats[] => {
            const map = new Map<string, GrowthSourceStats>();
            for (const u of list) {
                const key = u.source ?? 'organic';
                const entry = map.get(key) ?? { source: key, users: 0, paying: 0 };
                entry.users++;
                if (payingSet.has(u.id)) entry.paying++;
                map.set(key, entry);
            }
            return Array.from(map.values()).sort((a, b) => b.users - a.users);
        };

        // --- New users (7d) + activation (first research item within 24h of signup) ---
        const sevenDaysAgo = now - 7 * DAY_MS;
        const cohort7d = allUsers.filter((u) => u.createdAt && u.createdAt.getTime() >= sevenDaysAgo);

        const cohort7dIds = cohort7d.map((u) => u.id);
        const cohort7dResearch = cohort7dIds.length
            ? await db.select({ userId: researchItems.userId, createdAt: researchItems.createdAt })
                .from(researchItems)
                .where(inArray(researchItems.userId, cohort7dIds))
            : [];

        const firstResearchByUser = new Map<number, number>();
        for (const r of cohort7dResearch) {
            const t = r.createdAt.getTime();
            const existing = firstResearchByUser.get(r.userId);
            if (existing === undefined || t < existing) firstResearchByUser.set(r.userId, t);
        }

        let activatedCount = 0;
        for (const u of cohort7d) {
            const first = firstResearchByUser.get(u.id);
            if (first !== undefined && first <= u.createdAt!.getTime() + DAY_MS) activatedCount++;
        }

        // --- W2 retention: users whose "week 2" (day 7-14 after signup) has fully elapsed,
        // i.e. signed up 14-28 days ago, and saved research during that window ---
        const w2Cohort = allUsers.filter((u) => {
            if (!u.createdAt) return false;
            const age = now - u.createdAt.getTime();
            return age >= 14 * DAY_MS && age <= 28 * DAY_MS;
        });

        const w2Ids = w2Cohort.map((u) => u.id);
        const w2Research = w2Ids.length
            ? await db.select({ userId: researchItems.userId, createdAt: researchItems.createdAt })
                .from(researchItems)
                .where(inArray(researchItems.userId, w2Ids))
            : [];

        let w2RetainedCount = 0;
        for (const u of w2Cohort) {
            const signup = u.createdAt!.getTime();
            const active = w2Research.some((r) =>
                r.userId === u.id &&
                r.createdAt.getTime() >= signup + 7 * DAY_MS &&
                r.createdAt.getTime() < signup + 14 * DAY_MS
            );
            if (active) w2RetainedCount++;
        }

        // --- Referral & K-factor (successful = referee reached activation) ---
        const rewardedReferrals = await db.select({ id: referrals.id })
            .from(referrals)
            .where(eq(referrals.status, 'rewarded'));
        const referralCount = rewardedReferrals.length;

        return {
            totalUsers: allUsers.length,
            newUsers7d: cohort7d.length,
            newBySource: bySource(cohort7d),
            activatedCount,
            activationCohort: cohort7d.length,
            activationRate: cohort7d.length ? Math.round((activatedCount / cohort7d.length) * 100) : null,
            w2RetainedCount,
            w2Cohort: w2Cohort.length,
            w2RetentionRate: w2Cohort.length ? Math.round((w2RetainedCount / w2Cohort.length) * 100) : null,
            payingTotal: payingSet.size,
            payingBySource: bySource(allUsers),
            referralCount,
            kFactor: allUsers.length ? Math.round((referralCount / allUsers.length) * 100) / 100 : null,
        };
    }

    async getReport(): Promise<string> {
        const s = await this.getStats();

        const lines: string[] = [];
        lines.push('📊 Growth Dashboard');
        lines.push('');
        lines.push(`👥 Tổng user: ${s.totalUsers} · +${s.newUsers7d} mới (7 ngày)`);

        if (s.newBySource.length > 0) {
            lines.push('');
            lines.push('Nguồn user mới (7 ngày):');
            for (const row of s.newBySource) {
                lines.push(`• ${row.source}: ${row.users}`);
            }
        }

        lines.push('');
        lines.push(`🎯 Activation (lưu research trong 24h): ${
            s.activationRate === null
                ? 'chưa có user mới trong 7 ngày'
                : `${s.activatedCount}/${s.activationCohort} (${s.activationRate}%)`
        }`);

        lines.push(`📈 W2 Retention: ${
            s.w2RetentionRate === null
                ? 'chưa đủ dữ liệu (cần user ≥14 ngày)'
                : `${s.w2RetainedCount}/${s.w2Cohort} (${s.w2RetentionRate}%)`
        }`);

        lines.push('');
        lines.push(`💰 Paying: ${s.payingTotal}/${s.totalUsers}`);
        const payingRows = s.payingBySource.filter((row) => row.paying > 0);
        for (const row of payingRows) {
            lines.push(`• ${row.source}: ${row.paying}/${row.users}`);
        }

        lines.push('');
        lines.push(`🔁 Referral thành công: ${s.referralCount}` +
            (s.kFactor !== null ? ` · K-factor: ${s.kFactor}` : ''));

        return lines.join('\n');
    }
}
