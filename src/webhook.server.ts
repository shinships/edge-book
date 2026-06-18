import express from 'express';
import { Bot } from 'grammy';
import { config } from './config';
import { SepayService, SepayWebhookPayload } from './services/sepay.service';

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
            if (result) {
                const priceLabel = `${sepayService.getPrice(result.tier as 'pro' | 'premium').toLocaleString('vi-VN')}đ`;
                await sendUpgradeDm(bot, result.userId, result.tier as 'pro' | 'premium', priceLabel);
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
