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

// Kết quả xử lý webhook — discriminated union để server báo admin khi có
// giao dịch lạ (sai nội dung / sai số tiền) thay vì im lặng.
export type SepayResult =
    | { status: 'upgraded'; userId: number; tier: PlanTier }
    | { status: 'ignored' }                                   // không phải tiền vào, hoặc đã xử lý
    | { status: 'unmatched'; amount: number; content: string }// không parse được userId/tier
    | { status: 'underpaid'; userId: number; tier: PlanTier; amount: number; expected: number };

export class SepayService {
    constructor(private planService: PlanService) {}

    isConfigured(): boolean {
        return !!(config.sepayAccountNumber && config.sepayBankCode && config.sepayApiKey);
    }

    getPrice(tier: 'pro' | 'premium'): number {
        return tier === 'pro' ? config.sepayProPriceVnd : config.sepayPremiumPriceVnd;
    }

    // Payment content embeds the Telegram userId + tier so the webhook can match
    // the transfer back to a user without needing a separate "pending order" table.
    private buildPaymentContent(userId: number, tier: 'pro' | 'premium'): string {
        return `EBOOK${userId}${tier === 'pro' ? 'PRO' : 'PRE'}`;
    }

    // Build a dynamic VietQR image URL via qr.sepay.vn — scanning it pre-fills
    // the bank app with account, amount and transfer content.
    generateQuote(userId: number, tier: 'pro' | 'premium'): SepayQuote {
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

    private parsePaymentContent(text: string): { userId: number; tier: PlanTier } | null {
        const match = text.replace(/\s+/g, '').toUpperCase().match(/EBOOK(\d+)(PRO|PRE)/);
        if (!match) return null;

        const userId = parseInt(match[1], 10);
        if (!Number.isFinite(userId)) return null;

        return { userId, tier: match[2] === 'PRO' ? 'pro' : 'premium' };
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
        const expectedAmount = this.getPrice(tier as 'pro' | 'premium');
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

        await this.planService.upgradePlan(userId, tier, 30, undefined, String(payload.id));
        console.log(`✅ Upgraded user ${userId} to ${tier} via SePay (tx ${payload.id})`);

        return { status: 'upgraded', userId, tier };
    }
}
