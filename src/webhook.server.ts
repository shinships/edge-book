import express from 'express';
import { Bot } from 'grammy';
import { config } from './config';
import { PaymentService, LsWebhookPayload } from './services/payment.service';
import { SepayService, SepayWebhookPayload } from './services/sepay.service';

// -----------------------------------------------------------------------
// Webhook HTTP server for payment events (LemonSqueezy + SePay)
// -----------------------------------------------------------------------

/**
 * Start an Express server to receive payment webhooks.
 *
 * @param paymentService  - PaymentService instance (LemonSqueezy, shared with bot)
 * @param sepayService    - SepayService instance (VietQR bank transfer, shared with bot)
 * @param bot             - grammY Bot instance (used to DM the user after upgrade)
 */
// DM the user after a successful upgrade (used by both LemonSqueezy and SePay flows).
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

export function startWebhookServer(paymentService: PaymentService, sepayService: SepayService, bot: Bot): void {
    const app = express();

    // Health check (useful for ngrok / deployment verification)
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // LemonSqueezy webhook — must use raw body to verify HMAC signature
    app.post(
        '/webhook/lemonsqueezy',
        express.raw({ type: 'application/json' }),
        async (req, res) => {
            // 1. Verify signature
            const signature = req.headers['x-signature'] as string | undefined;

            if (!signature) {
                console.warn('Webhook: missing x-signature header');
                return res.status(401).json({ error: 'Missing signature' });
            }

            const isValid = paymentService.verifyWebhookSignature(req.body as Buffer, signature);
            if (!isValid) {
                console.warn('Webhook: invalid HMAC signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }

            // 2. Parse payload
            let payload: LsWebhookPayload;
            try {
                payload = JSON.parse((req.body as Buffer).toString('utf8')) as LsWebhookPayload;
            } catch (err) {
                console.error('Webhook: failed to parse JSON body', err);
                return res.status(400).json({ error: 'Invalid JSON' });
            }

            // 3. Acknowledge immediately (LS retries if we don't respond quickly)
            res.status(200).json({ received: true });

            // 4. Process event (async — after response sent)
            try {
                const result = await paymentService.handleWebhookEvent(payload);
                if (result) {
                    const tier = result.tier as 'pro' | 'premium';
                    const priceLabel = tier === 'pro' ? '$9.99' : '$24.99';
                    await sendUpgradeDm(bot, result.userId, tier, priceLabel);
                }
            } catch (err) {
                console.error('Webhook processing error:', err);
            }
        }
    );

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

    // Start server
    const port = config.webhookPort;
    app.listen(port, () => {
        console.log(`🔗 Webhook server running on port ${port}`);
        console.log(`   Health: http://localhost:${port}/health`);
        console.log(`   LemonSqueezy endpoint: http://localhost:${port}/webhook/lemonsqueezy`);
        console.log(`   SePay endpoint: http://localhost:${port}/webhook/sepay`);
    });
}
