import { config } from '../config';
import { PlanService, PlanTier } from './plan.service';

// -----------------------------------------------------------------------
// SePay (VietQR bank-transfer) payment integration
// -----------------------------------------------------------------------

// Webhook payload sent by SePay when a transaction hits the linked bank account.
// https://docs.sepay.vn/tich-hop-webhooks.html
export interface SepayWebhookPayload {
    id: number;
    gateway: string;
    transactionDate: string;
    accountNumber: string;
    subAccount?: string;
    code: string | null;
    content: string;
    transferType: string; // 'in' | 'out'
    description: string;
    transferAmount: number;
    accumulated: number;
    referenceCode: string;
}

export interface SepayQuote {
    qrUrl: string;
    amount: number;
    content: string;
}

// Trial pack: tier nội bộ tách riêng để parse webhook + định giá, nhưng plan
// thật sự cấp cho user vẫn là 'pro' (xem PlanService.activateTrial).
export type PaymentTier = 'pro' | 'premium' | 'trial';

// Kết quả xử lý webhook — discriminated union để server báo admin khi có
// giao dịch lạ (sai nội dung / sai số tiền) thay vì im lặng.
export type SepayResult =
    | { status: 'upgraded'; userId: number; tier: PlanTier }
    | { status: 'trial_activated'; userId: number }
    | { status: 'trial_reused'; userId: number; amount: number; txId: string } // đã dùng trial trước đó
    | { status: 'ignored' }                                   // không phải tiền vào, hoặc đã xử lý
    | { status: 'unmatched'; amount: number; content: string }// không parse được userId/tier
    | { status: 'underpaid'; userId: number; tier: PaymentTier; amount: number; expected: number };

export class SepayService {
    constructor(private planService: PlanService) {}

    isConfigured(): boolean {
        return !!(config.sepayAccountNumber && config.sepayBankCode && config.sepayApiKey);
    }

    getPrice(tier: PaymentTier): number {
        if (tier === 'trial') return config.sepayTrialPriceVnd;
        return tier === 'pro' ? config.sepayProPriceVnd : config.sepayPremiumPriceVnd;
    }

    // Payment content embeds the Telegram userId + tier so the webhook can match
    // the transfer back to a user without needing a separate "pending order" table.
    private buildPaymentContent(userId: number, tier: PaymentTier): string {
        const code = tier === 'pro' ? 'PRO' : tier === 'premium' ? 'PRE' : 'TRI';
        return `EBOOK${userId}${code}`;
    }

    // Build a dynamic VietQR image URL via qr.sepay.vn — scanning it pre-fills
    // the bank app with account, amount and transfer content.
    generateQuote(userId: number, tier: PaymentTier): SepayQuote {
        const amount = this.getPrice(tier);
        const content = this.buildPaymentContent(userId, tier);

        const params = new URLSearchParams({
            acc: config.sepayAccountNumber,
            bank: config.sepayBankCode,
            amount: String(amount),
            des: content,
        });
        if (config.sepayAccountHolder) params.set('holder', config.sepayAccountHolder);

        return { qrUrl: `https://qr.sepay.vn/img?${params.toString()}`, amount, content };
    }

    // SePay webhook auth: "Authorization: Apikey <SEPAY_API_KEY>"
    verifyAuth(authHeader?: string): boolean {
        if (!config.sepayApiKey) return false;
        return authHeader === `Apikey ${config.sepayApiKey}`;
    }

    private parsePaymentContent(text: string): { userId: number; tier: PaymentTier } | null {
        const match = text.replace(/\s+/g, '').toUpperCase().match(/EBOOK(\d+)(PRO|PRE|TRI)/);
        if (!match) return null;

        const userId = parseInt(match[1], 10);
        if (!Number.isFinite(userId)) return null;

        const tier: PaymentTier = match[2] === 'PRO' ? 'pro' : match[2] === 'PRE' ? 'premium' : 'trial';
        return { userId, tier };
    }

    // Xử lý 1 giao dịch SePay. Trả về SepayResult để server biết DM user (upgraded)
    // hay báo admin (unmatched / underpaid).
    async handleWebhookEvent(payload: SepayWebhookPayload): Promise<SepayResult> {
        if (payload.transferType !== 'in') {
            return { status: 'ignored' };
        }

        const parsed = this.parsePaymentContent(payload.content || payload.description || '');
        if (!parsed) {
            console.log(`SePay webhook: could not parse payment code from content "${payload.content}"`);
            return { status: 'unmatched', amount: payload.transferAmount, content: payload.content || payload.description || '' };
        }

        const { userId, tier } = parsed;
        const expectedAmount = this.getPrice(tier);
        if (payload.transferAmount < expectedAmount) {
            console.warn(`SePay webhook: amount ${payload.transferAmount} < expected ${expectedAmount} for user ${userId} (${tier})`);
            return { status: 'underpaid', userId, tier, amount: payload.transferAmount, expected: expectedAmount };
        }

        // Idempotency — skip if this SePay transaction was already processed
        const currentPlan = await this.planService.getPlan(userId);
        if (currentPlan.sepayTxId === String(payload.id)) {
            console.log(`SePay webhook: tx ${payload.id} already processed for user ${userId}, skipping.`);
            return { status: 'ignored' };
        }

        if (tier === 'trial') {
            const result = await this.planService.activateTrial(userId, String(payload.id));
            if (!result.ok) {
                console.warn(`SePay webhook: trial reuse for user ${userId} (tx ${payload.id})`);
                return { status: 'trial_reused', userId, amount: payload.transferAmount, txId: String(payload.id) };
            }
            console.log(`🎁 Activated trial for user ${userId} via SePay (tx ${payload.id})`);
            return { status: 'trial_activated', userId };
        }

        await this.planService.upgradePlan(userId, tier, 30, undefined, String(payload.id));
        console.log(`✅ Upgraded user ${userId} to ${tier} via SePay (tx ${payload.id})`);

        return { status: 'upgraded', userId, tier };
    }
}
