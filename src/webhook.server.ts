import express from 'express';
import { Bot } from 'grammy';
import { config } from './config';
import { SepayService, SepayWebhookPayload } from './services/sepay.service';

// Báo cho admin (ADMIN_USER_IDS) khi có giao dịch SePay vào tài khoản nhưng
// không tự nâng cấp được (sai nội dung CK, hoặc chuyển thiếu tiền) — tránh
// trường hợp user chuyển khoản mà hệ thống im lặng, không ai biết để xử lý tay.
async function notifyAdmins(bot: Bot, message: string): Promise<void> {
    for (const adminId of config.adminUserIds) {
        try {
            await bot.api.sendMessage(adminId, message);
        } catch (err) {
            console.error(`Failed to DM admin ${adminId}:`, err);
        }
    }
}

// -----------------------------------------------------------------------
// Webhook HTTP server for payment events (SePay VietQR only)
// -----------------------------------------------------------------------

async function sendUpgradeDm(bot: Bot, userId: number, tier: 'pro' | 'premium', priceLabel: string): Promise<void> {
    const tierEmoji = tier === 'pro' ? '⭐' : '💎';
    const tierName = tier === 'pro' ? 'Pro' : 'Premium';

    await bot.api.sendMessage(
        userId,
        `🎉 Thanh toán thành công!\n\n` +
        `${tierEmoji} Plan của bạn đã được nâng cấp lên ${tierName} (${priceLabel}/tháng).\n\n` +
        `✅ Đã mở khoá:\n` +
        (tier === 'pro'
            ? `• Unlimited forwards\n• Search & Tag\n• Daily Digest\n• Ask AI về research`
            : `• Tất cả tính năng Pro\n• Sentiment scoring\n• Export research\n• Unlimited Docs`) +
        `\n\nGõ /plan để xem chi tiết plan của bạn. Cảm ơn đã ủng hộ! 🚀`
    );
}

export function startWebhookServer(sepayService: SepayService, bot: Bot): void {
    const app = express();

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // TODO(intl-payments): Re-add the /webhook/lemonsqueezy endpoint here for international cards.
    // It needs express.raw() (not express.json()) so the raw Buffer is available for HMAC-SHA256
    // signature verification (PaymentService.verifyWebhookSignature). See git history (Sprint 10-14).

    // SePay webhook — VietQR bank-transfer notifications. JSON body, API-key auth.
    app.post('/webhook/sepay', express.json(), async (req, res) => {
        const authHeader = req.headers['authorization'] as string | undefined;
        if (!sepayService.verifyAuth(authHeader)) {
            console.warn('SePay webhook: invalid or missing Authorization header');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Acknowledge immediately (SePay requires a 200 within 30s)
        res.status(200).json({ success: true });

        try {
            const payload = req.body as SepayWebhookPayload;
            const result = await sepayService.handleWebhookEvent(payload);

            if (result.status === 'upgraded') {
                const priceLabel = `${sepayService.getPrice(result.tier as 'pro' | 'premium').toLocaleString('vi-VN')}đ`;
                await sendUpgradeDm(bot, result.userId, result.tier as 'pro' | 'premium', priceLabel);
            } else if (result.status === 'unmatched') {
                await notifyAdmins(
                    bot,
                    `⚠️ SePay: nhận ${result.amount.toLocaleString('vi-VN')}đ nhưng KHÔNG đọc được nội dung CK.\n` +
                    `Nội dung: "${result.content}"\n` +
                    `→ Cần kiểm tra & nâng cấp tay (tx ${payload.id}).`
                );
            } else if (result.status === 'underpaid') {
                await notifyAdmins(
                    bot,
                    `⚠️ SePay: user ${result.userId} chuyển THIẾU tiền cho ${result.tier}.\n` +
                    `Nhận ${result.amount.toLocaleString('vi-VN')}đ / cần ${result.expected.toLocaleString('vi-VN')}đ (tx ${payload.id}).\n` +
                    `→ Cần liên hệ user hoặc hoàn tiền.`
                );
            }
        } catch (err) {
            console.error('SePay webhook processing error:', err);
        }
    });

    app.listen(config.webhookPort, () => {
        console.log(`🔗 Webhook server running on port ${config.webhookPort}`);
        console.log(`   Health: http://localhost:${config.webhookPort}/health`);
        console.log(`   SePay endpoint: http://localhost:${config.webhookPort}/webhook/sepay`);
    });
}
