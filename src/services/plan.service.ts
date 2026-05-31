import * as fs from 'fs';
import * as path from 'path';

// --- Interfaces ---

export type PlanTier = 'free' | 'pro' | 'premium';

export interface UserPlan {
    userId: number;
    tier: PlanTier;
    expiresAt?: string;         // ISO string — undefined = never expires (for free)
    dailyForwardCount: number;  // Reset daily
    lastResetDate: string;      // YYYY-MM-DD
    lsOrderId?: string;         // LemonSqueezy order ID for idempotency
}

// --- Feature gates ---

export interface PlanLimits {
    maxForwardsPerDay: number;  // -1 = unlimited
    canSearch: boolean;
    canDigest: boolean;
    canStar: boolean;
    canSentiment: boolean;
    canExport: boolean;
    canTrade: boolean;          // Trade Journal (Pro+)
    canLinkResearch: boolean;   // Research-to-trade link (Premium)
    maxDocs: number;            // -1 = unlimited
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
        maxDocs: -1,
    },
};

// --- Service ---

export class PlanService {
    private dataPath: string;
    private plans: Map<number, UserPlan>;

    constructor() {
        this.dataPath = path.resolve(__dirname, '../../data/plans.json');
        this.plans = new Map();
        this.loadData();
    }

    // --- Persistence ---

    private loadData() {
        if (fs.existsSync(this.dataPath)) {
            try {
                const rawData = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(rawData);
                if (Array.isArray(parsed)) {
                    parsed.forEach((p: UserPlan) => this.plans.set(p.userId, p));
                }
            } catch (error) {
                console.error('Error loading plan data:', error);
            }
        }
    }

    private saveData() {
        try {
            const data = Array.from(this.plans.values());
            const dir = path.dirname(this.dataPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Error saving plan data:', error);
        }
    }

    // --- Plan Management ---

    private getTodayString(): string {
        return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    }

    /**
     * Get or create a user's plan (default: free).
     */
    getPlan(userId: number): UserPlan {
        if (!this.plans.has(userId)) {
            const plan: UserPlan = {
                userId,
                tier: 'free',
                dailyForwardCount: 0,
                lastResetDate: this.getTodayString(),
            };
            this.plans.set(userId, plan);
            this.saveData();
        }

        const plan = this.plans.get(userId)!;

        // Reset daily counter if new day
        const today = this.getTodayString();
        if (plan.lastResetDate !== today) {
            plan.dailyForwardCount = 0;
            plan.lastResetDate = today;
            this.saveData();
        }

        return plan;
    }

    /**
     * Get the limits for a user's current plan.
     */
    getLimits(userId: number): PlanLimits {
        const plan = this.getPlan(userId);
        return PLAN_LIMITS[plan.tier];
    }

    /**
     * Check if user can use a specific feature.
     */
    canUse(userId: number, feature: keyof Omit<PlanLimits, 'maxForwardsPerDay' | 'maxDocs'>): boolean {
        return this.getLimits(userId)[feature] as boolean;
    }

    /**
     * Check if user can forward more messages today.
     * Returns { allowed: boolean, remaining: number, limit: number }.
     */
    canForward(userId: number): { allowed: boolean; remaining: number; limit: number } {
        const plan = this.getPlan(userId);
        const limits = PLAN_LIMITS[plan.tier];

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

    /**
     * Increment the daily forward counter.
     */
    incrementForwardCount(userId: number) {
        const plan = this.getPlan(userId);
        plan.dailyForwardCount++;
        this.saveData();
    }

    /**
     * Upgrade a user's plan.
     * @param orderId — Optional LemonSqueezy order ID to store for idempotency.
     */
    upgradePlan(userId: number, tier: PlanTier, durationDays?: number, orderId?: string) {
        const plan = this.getPlan(userId);
        plan.tier = tier;
        if (durationDays) {
            const expires = new Date();
            expires.setDate(expires.getDate() + durationDays);
            plan.expiresAt = expires.toISOString();
        } else {
            plan.expiresAt = undefined;
        }
        if (orderId) {
            plan.lsOrderId = orderId;
        }
        this.saveData();
    }

    /**
     * Check and downgrade expired plans.
     */
    checkExpiredPlans() {
        const now = new Date().toISOString();
        for (const [userId, plan] of this.plans.entries()) {
            if (plan.expiresAt && plan.expiresAt < now && plan.tier !== 'free') {
                plan.tier = 'free';
                plan.expiresAt = undefined;
                console.log(`Plan expired for user ${userId}, downgraded to free.`);
            }
        }
        this.saveData();
    }

    /**
     * Get plan display info for a user.
     */
    getPlanInfo(userId: number): string {
        const plan = this.getPlan(userId);
        const limits = PLAN_LIMITS[plan.tier];
        const forwardStatus = this.canForward(userId);

        const tierEmoji = plan.tier === 'free' ? '🆓' : plan.tier === 'pro' ? '⭐' : '💎';
        let info = `${tierEmoji} Plan: ${plan.tier.toUpperCase()}\n`;

        if (limits.maxForwardsPerDay !== -1) {
            info += `📤 Forwards hôm nay: ${plan.dailyForwardCount}/${limits.maxForwardsPerDay}\n`;
        } else {
            info += `📤 Forwards: Unlimited\n`;
        }

        info += `🔍 Search: ${limits.canSearch ? '✅' : '🔒 Pro'}\n`;
        info += `📊 Daily Digest: ${limits.canDigest ? '✅' : '🔒 Pro'}\n`;
        info += `📈 Sentiment: ${limits.canSentiment ? '✅' : '🔒 Premium'}\n`;
        info += `📄 Export: ${limits.canExport ? '✅' : '🔒 Premium'}`;

        if (plan.expiresAt) {
            const expDate = new Date(plan.expiresAt).toLocaleDateString('vi-VN');
            info += `\n⏰ Hết hạn: ${expDate}`;
        } else if (plan.tier !== 'free') {
            info += `\n♾️ Không giới hạn thời gian`;
        }

        if (plan.tier === 'free') {
            info += `\n\n💡 Upgrade để mở khoá Search, Digest và nhiều hơn nữa!\n👉 Gõ /upgrade để xem các gói`;
        }

        return info;
    }

    /**
     * Get all user IDs with active Pro/Premium plans (for digest cron).
     */
    getDigestEligibleUsers(): number[] {
        const eligible: number[] = [];
        for (const [userId, plan] of this.plans.entries()) {
            if (PLAN_LIMITS[plan.tier].canDigest) {
                eligible.push(userId);
            }
        }
        return eligible;
    }
}
