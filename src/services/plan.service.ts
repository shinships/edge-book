import { db } from '../db';
import { plans } from '../db/schema';
import { eq, and, lt, isNotNull, ne } from 'drizzle-orm';

// --- Interfaces ---

export type PlanTier = 'free' | 'pro' | 'premium';

export interface UserPlan {
    userId: number;
    tier: PlanTier;
    expiresAt?: string;
    dailyForwardCount: number;
    lastResetDate: string;
    lsOrderId?: string;
}

export interface PlanLimits {
    maxForwardsPerDay: number;
    canSearch: boolean;
    canDigest: boolean;
    canStar: boolean;
    canSentiment: boolean;
    canExport: boolean;
    canTrade: boolean;
    canLinkResearch: boolean;
    canAnalytics: boolean;
    canThesis: boolean;
    maxDocs: number;
}

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
    free: {
        maxForwardsPerDay: 10,
        canSearch: false,
        canDigest: false,
        canStar: true,
        canSentiment: false,
        canExport: false,
        canTrade: false,
        canLinkResearch: false,
        canAnalytics: false,
        canThesis: false,
        maxDocs: 1,
    },
    pro: {
        maxForwardsPerDay: -1,
        canSearch: true,
        canDigest: true,
        canStar: true,
        canSentiment: false,
        canExport: false,
        canTrade: true,
        canLinkResearch: false,
        canAnalytics: false,
        canThesis: false,
        maxDocs: 5,
    },
    premium: {
        maxForwardsPerDay: -1,
        canSearch: true,
        canDigest: true,
        canStar: true,
        canSentiment: true,
        canExport: true,
        canTrade: true,
        canLinkResearch: true,
        canAnalytics: true,
        canThesis: true,
        maxDocs: -1,
    },
};

type PlanRow = typeof plans.$inferSelect;

function toPlan(row: PlanRow): UserPlan {
    return {
        userId: row.userId,
        tier: row.tier as PlanTier,
        expiresAt: row.expiresAt?.toISOString(),
        dailyForwardCount: row.dailyForwardCount,
        lastResetDate: row.lastResetDate,
        lsOrderId: row.lsOrderId ?? undefined,
    };
}

// --- Service ---

export class PlanService {
    private adminIds: Set<number>;

    constructor(adminIds: number[] = []) {
        this.adminIds = new Set(adminIds);
    }

    isAdmin(userId: number): boolean {
        return this.adminIds.has(userId);
    }

    private effectiveTier(plan: UserPlan, userId: number): PlanTier {
        if (this.isAdmin(userId)) return 'premium';
        return plan.tier;
    }

    private getTodayString(): string {
        return new Date().toISOString().split('T')[0];
    }

    async getPlan(userId: number): Promise<UserPlan> {
        const today = this.getTodayString();

        await db.insert(plans).values({
            userId,
            tier: 'free',
            dailyForwardCount: 0,
            lastResetDate: today,
        }).onConflictDoNothing();

        const [row] = await db.select().from(plans).where(eq(plans.userId, userId));

        if (row.lastResetDate !== today) {
            const [updated] = await db.update(plans)
                .set({ dailyForwardCount: 0, lastResetDate: today })
                .where(eq(plans.userId, userId))
                .returning();
            return toPlan(updated!);
        }

        return toPlan(row!);
    }

    async getLimits(userId: number): Promise<PlanLimits> {
        const plan = await this.getPlan(userId);
        return PLAN_LIMITS[this.effectiveTier(plan, userId)];
    }

    async canUse(userId: number, feature: keyof Omit<PlanLimits, 'maxForwardsPerDay' | 'maxDocs'>): Promise<boolean> {
        const limits = await this.getLimits(userId);
        return limits[feature] as boolean;
    }

    async canForward(userId: number): Promise<{ allowed: boolean; remaining: number; limit: number }> {
        const plan = await this.getPlan(userId);
        const limits = PLAN_LIMITS[this.effectiveTier(plan, userId)];

        if (limits.maxForwardsPerDay === -1) {
            return { allowed: true, remaining: -1, limit: -1 };
        }

        const remaining = limits.maxForwardsPerDay - plan.dailyForwardCount;
        return {
            allowed: remaining > 0,
            remaining: Math.max(0, remaining),
            limit: limits.maxForwardsPerDay,
        };
    }

    async incrementForwardCount(userId: number): Promise<void> {
        const plan = await this.getPlan(userId);
        await db.update(plans)
            .set({ dailyForwardCount: plan.dailyForwardCount + 1 })
            .where(eq(plans.userId, userId));
    }

    async upgradePlan(userId: number, tier: PlanTier, durationDays?: number, orderId?: string): Promise<void> {
        await this.getPlan(userId); // ensure exists

        let expiresAt: Date | null = null;
        if (durationDays) {
            expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + durationDays);
        }

        const set: Partial<typeof plans.$inferInsert> = { tier };
        if (expiresAt !== null) set.expiresAt = expiresAt;
        if (orderId) set.lsOrderId = orderId;

        await db.update(plans).set(set).where(eq(plans.userId, userId));
    }

    async checkExpiredPlans(): Promise<void> {
        await db.update(plans)
            .set({ tier: 'free', expiresAt: null })
            .where(
                and(
                    isNotNull(plans.expiresAt),
                    lt(plans.expiresAt, new Date()),
                    ne(plans.tier, 'free')
                )
            );
    }

    async getPlanInfo(userId: number): Promise<string> {
        const plan = await this.getPlan(userId);
        const tier = this.effectiveTier(plan, userId);
        const limits = PLAN_LIMITS[tier];
        const admin = this.isAdmin(userId);

        const tierEmoji = admin ? '🛡️' : tier === 'free' ? '🆓' : tier === 'pro' ? '⭐' : '💎';
        let info = admin
            ? `🛡️ Plan: ADMIN (Premium access)\n`
            : `${tierEmoji} Plan: ${tier.toUpperCase()}\n`;

        if (limits.maxForwardsPerDay !== -1) {
            info += `📤 Forwards hôm nay: ${plan.dailyForwardCount}/${limits.maxForwardsPerDay}\n`;
        } else {
            info += `📤 Forwards: Unlimited\n`;
        }

        info += `🔍 Search: ${limits.canSearch ? '✅' : '🔒 Pro'}\n`;
        info += `📊 Daily Digest: ${limits.canDigest ? '✅' : '🔒 Pro'}\n`;
        info += `📈 Sentiment: ${limits.canSentiment ? '✅' : '🔒 Premium'}\n`;
        info += `📄 Export: ${limits.canExport ? '✅' : '🔒 Premium'}`;

        if (admin) {
            info += `\n♾️ Quyền admin: không giới hạn thời gian`;
        } else if (plan.expiresAt) {
            const expDate = new Date(plan.expiresAt).toLocaleDateString('vi-VN');
            info += `\n⏰ Hết hạn: ${expDate}`;
        } else if (tier !== 'free') {
            info += `\n♾️ Không giới hạn thời gian`;
        }

        if (!admin && tier === 'free') {
            info += `\n\n💡 Upgrade để mở khoá Search, Digest và nhiều hơn nữa!\n👉 Gõ /upgrade để xem các gói`;
        }

        return info;
    }

    async getDigestEligibleUsers(): Promise<number[]> {
        const rows = await db.select({ userId: plans.userId, tier: plans.tier }).from(plans);
        const eligible = new Set<number>();
        for (const row of rows) {
            if (PLAN_LIMITS[row.tier as PlanTier]?.canDigest) {
                eligible.add(row.userId);
            }
        }
        for (const adminId of this.adminIds) {
            eligible.add(adminId);
        }
        return Array.from(eligible);
    }
}
