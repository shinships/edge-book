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
    dailyChatCount: number;
    lastResetDate: string;
    lsOrderId?: string;
    sepayTxId?: string;
    digestEnabled: boolean;
    trialUsedAt?: string;
}

export interface PlanLimits {
    maxForwardsPerDay: number;
    maxChatsPerDay: number;   // -1 = unlimited
    canSearch: boolean;
    canDigest: boolean;
    canStar: boolean;
    canSentiment: boolean;
    canExport: boolean;
    canTrade: boolean;
    canLinkResearch: boolean;
    canAnalytics: boolean;
    canThesis: boolean;
    canPortfolio: boolean;
    maxDocs: number;
    maxWatchlist: number;     // -1 = unlimited
    maxActiveAlerts: number;  // 0 = feature locked, -1 = unlimited
}

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
    free: {
        maxForwardsPerDay: 10,
        maxChatsPerDay: 1,
        canSearch: false,
        canDigest: false,
        canStar: true,
        canSentiment: false,
        canExport: false,
        canTrade: false,
        canLinkResearch: false,
        canAnalytics: false,
        canThesis: false,
        canPortfolio: false,
        maxDocs: 1,
        maxWatchlist: 3,
        maxActiveAlerts: 0,
    },
    pro: {
        maxForwardsPerDay: -1,
        maxChatsPerDay: 20,
        canSearch: true,
        canDigest: true,
        canStar: true,
        canSentiment: false,
        canExport: false,
        canTrade: true,
        canLinkResearch: false,
        canAnalytics: false,
        canThesis: false,
        canPortfolio: true,
        maxDocs: 5,
        maxWatchlist: -1,
        maxActiveAlerts: 10,
    },
    premium: {
        maxForwardsPerDay: -1,
        maxChatsPerDay: 60,
        canSearch: true,
        canDigest: true,
        canStar: true,
        canSentiment: true,
        canExport: true,
        canTrade: true,
        canLinkResearch: true,
        canAnalytics: true,
        canThesis: true,
        canPortfolio: true,
        maxDocs: -1,
        maxWatchlist: -1,
        maxActiveAlerts: -1,
    },
};

type PlanRow = typeof plans.$inferSelect;

function toPlan(row: PlanRow): UserPlan {
    return {
        userId: row.userId,
        tier: row.tier as PlanTier,
        expiresAt: row.expiresAt?.toISOString(),
        dailyForwardCount: row.dailyForwardCount,
        dailyChatCount: row.dailyChatCount,
        lastResetDate: row.lastResetDate,
        lsOrderId: row.lsOrderId ?? undefined,
        sepayTxId: row.sepayTxId ?? undefined,
        digestEnabled: row.digestEnabled,
        trialUsedAt: row.trialUsedAt?.toISOString(),
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
            dailyChatCount: 0,
            lastResetDate: today,
        }).onConflictDoNothing();

        const [row] = await db.select().from(plans).where(eq(plans.userId, userId));

        if (row.lastResetDate !== today) {
            const [updated] = await db.update(plans)
                .set({ dailyForwardCount: 0, dailyChatCount: 0, lastResetDate: today })
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

    async canUse(userId: number, feature: keyof Omit<PlanLimits, 'maxForwardsPerDay' | 'maxDocs' | 'maxWatchlist' | 'maxActiveAlerts'>): Promise<boolean> {
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

    async canChat(userId: number): Promise<{ allowed: boolean; remaining: number; limit: number }> {
        const plan = await this.getPlan(userId);
        const limits = PLAN_LIMITS[this.effectiveTier(plan, userId)];

        if (limits.maxChatsPerDay === -1) {
            return { allowed: true, remaining: -1, limit: -1 };
        }

        const remaining = limits.maxChatsPerDay - plan.dailyChatCount;
        return {
            allowed: remaining > 0,
            remaining: Math.max(0, remaining),
            limit: limits.maxChatsPerDay,
        };
    }

    async incrementChatCount(userId: number): Promise<void> {
        const plan = await this.getPlan(userId);
        await db.update(plans)
            .set({ dailyChatCount: plan.dailyChatCount + 1 })
            .where(eq(plans.userId, userId));
    }

    async setDigestEnabled(userId: number, enabled: boolean): Promise<void> {
        await this.getPlan(userId); // ensure row exists
        await db.update(plans).set({ digestEnabled: enabled }).where(eq(plans.userId, userId));
    }

    async upgradePlan(userId: number, tier: PlanTier, durationDays?: number, orderId?: string, sepayTxId?: string): Promise<void> {
        const plan = await this.getPlan(userId); // ensure exists

        // Không hạ tier ngầm: nếu user đang ở tier cao hơn tier vừa trả tiền
        // (vd Premium lỡ quét QR Pro), giữ nguyên tier cao và vẫn cộng thêm ngày.
        const tierRank: Record<PlanTier, number> = { free: 0, pro: 1, premium: 2 };
        const effectiveTier = tierRank[plan.tier] > tierRank[tier] ? plan.tier : tier;

        let expiresAt: Date | null = null;
        if (durationDays) {
            // Cộng dồn: gia hạn nối tiếp từ ngày hết hạn hiện tại nếu còn hạn,
            // ngược lại tính từ bây giờ. Tránh user mất số ngày còn lại khi gia hạn.
            const now = new Date();
            const base = plan.expiresAt && new Date(plan.expiresAt) > now ? new Date(plan.expiresAt) : now;
            expiresAt = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);
        }

        const set: Partial<typeof plans.$inferInsert> = { tier: effectiveTier };
        if (expiresAt !== null) set.expiresAt = expiresAt;
        if (orderId) set.lsOrderId = orderId;
        if (sepayTxId) set.sepayTxId = sepayTxId;

        await db.update(plans).set(set).where(eq(plans.userId, userId));
    }

    async hasUsedTrial(userId: number): Promise<boolean> {
        const plan = await this.getPlan(userId);
        return !!plan.trialUsedAt;
    }

    // Trial Pack 19k / 7 ngày Pro — 1 lần/user. Riêng khỏi upgradePlan vì cần
    // atomic check + set trialUsedAt, và không nên cộng dồn nếu user đang Pro
    // (trial chỉ dành cho free user, gate ở /upgrade UI).
    async activateTrial(userId: number, txId: string): Promise<{ ok: true } | { ok: false; reason: 'already_used' }> {
        const plan = await this.getPlan(userId);
        if (plan.trialUsedAt) {
            return { ok: false, reason: 'already_used' };
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        await db.update(plans).set({
            tier: 'pro',
            expiresAt,
            trialUsedAt: now,
            sepayTxId: txId,
        }).where(eq(plans.userId, userId));

        return { ok: true };
    }

    // Grant bonus days on top of the user's current plan (referral rewards,
    // milestones) without ever downgrading tier. Extends expiresAt from "now"
    // or from the existing expiry, whichever is later.
    async grantBonusDays(userId: number, days: number, minTier: PlanTier = 'pro'): Promise<void> {
        const plan = await this.getPlan(userId);

        const tierRank: Record<PlanTier, number> = { free: 0, pro: 1, premium: 2 };
        const tier = tierRank[plan.tier] >= tierRank[minTier] ? plan.tier : minTier;

        const base = plan.expiresAt && new Date(plan.expiresAt) > new Date() ? new Date(plan.expiresAt) : new Date();
        const expiresAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

        await db.update(plans).set({ tier, expiresAt }).where(eq(plans.userId, userId));
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

        if (limits.maxChatsPerDay !== -1) {
            info += `💬 Chat AI hôm nay: ${plan.dailyChatCount}/${limits.maxChatsPerDay}\n`;
        } else {
            info += `💬 Chat AI: Unlimited\n`;
        }

        info += `🔍 Search: ${limits.canSearch ? '✅' : '🔒 Pro'}\n`;
        if (limits.canDigest) {
            info += `📊 Daily Digest: ${plan.digestEnabled ? '✅ Bật' : '🔕 Tắt'} (Digest On/Off để đổi)\n`;
        } else {
            info += `📊 Daily Digest: 🔒 Pro\n`;
        }
        info += `📈 Sentiment: ${limits.canSentiment ? '✅' : '🔒 Premium'}\n`;
        const alertLimit = limits.maxActiveAlerts === 0
            ? '🔒 Pro'
            : limits.maxActiveAlerts === -1 ? 'Unlimited' : `tối đa ${limits.maxActiveAlerts}`;
        info += `🔔 Price Alerts: ${alertLimit}\n`;
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
            if (!plan.trialUsedAt) {
                info += `\n🎁 Trial 7 ngày Pro (19k) còn dùng được — chọn trong /upgrade`;
            }
        }

        return info;
    }

    async getDigestEligibleUsers(): Promise<number[]> {
        const rows = await db.select({ userId: plans.userId, tier: plans.tier, digestEnabled: plans.digestEnabled }).from(plans);
        const eligible = new Set<number>();
        for (const row of rows) {
            if (row.digestEnabled && PLAN_LIMITS[row.tier as PlanTier]?.canDigest) {
                eligible.add(row.userId);
            }
        }
        for (const adminId of this.adminIds) {
            // Admins still respect their own digestEnabled setting
            const adminRow = rows.find(r => r.userId === adminId);
            if (!adminRow || adminRow.digestEnabled) {
                eligible.add(adminId);
            }
        }
        return Array.from(eligible);
    }
}
