import express from 'express';
import { Bot } from 'grammy';
import { config } from './config';
import { SepayService, SepayWebhookPayload } from './services/sepay.service';
import { GoogleOAuthService } from './services/google-oauth.service';

// Minimal HTML page shown in the user's browser after the OAuth redirect.
function oauthResultPage(ok: boolean, message: string): string {
    const color = ok ? '#16a34a' : '#dc2626';
    const icon = ok ? '✅' : '⚠️';
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>EdgeBook</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;text-align:center">` +
        `<div style="font-size:48px">${icon}</div>` +
        `<h2 style="color:${color}">${message}</h2>` +
        `<p style="color:#555">Bạn có thể đóng tab này và quay lại Telegram.</p>` +
        `</body></html>`;
}

// Simple static privacy policy page — required by Google OAuth verification
// (Branding tab → Privacy Policy link). Plain HTML, no templating dependency.
const PRIVACY_POLICY_HTML = `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeBook — Chính sách quyền riêng tư</title></head>
<body style="font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1f2937">
<h1>EdgeBook — Chính sách quyền riêng tư</h1>
<p><strong>Cập nhật lần cuối:</strong> 2026-06-29</p>

<p>EdgeBook là một Telegram bot hỗ trợ nghiên cứu &amp; quản lý giao dịch cá nhân. Trang này mô tả dữ liệu chúng tôi thu thập và cách sử dụng.</p>

<h2>1. Dữ liệu thu thập</h2>
<ul>
<li>Telegram user ID, username, tên hiển thị (do bạn cung cấp qua Telegram)</li>
<li>Nội dung bạn forward/gõ vào bot (tin tức, ghi chú nghiên cứu, lệnh giao dịch)</li>
<li>Nếu bạn chọn kết nối Google (tính năng "Connect Docs"): access/refresh token OAuth (Google), được mã hoá AES-256-GCM khi lưu, và địa chỉ email Google của bạn</li>
</ul>

<h2>2. Quyền Google OAuth (drive.file)</h2>
<p>Khi bạn kết nối Google Docs, EdgeBook chỉ yêu cầu scope <code>drive.file</code> — phạm vi hẹp nhất của Google Drive API. Với scope này, bot <strong>chỉ có thể truy cập các file do chính bot tạo ra</strong> (1 Google Doc mới trong Drive của bạn để lưu research). Bot <strong>không thể</strong> xem, sửa, hoặc xoá bất kỳ file nào khác đã có sẵn trong Drive của bạn.</p>

<h2>3. Mục đích sử dụng</h2>
<p>Dữ liệu được dùng duy nhất để vận hành các tính năng của bot cho chính bạn: lưu trữ research, nhật ký giao dịch, nhắc lịch, tạo digest/báo cáo. Chúng tôi không bán, không chia sẻ dữ liệu cá nhân cho bên thứ ba.</p>

<h2>4. Lưu trữ &amp; xoá dữ liệu</h2>
<p>Dữ liệu được lưu trên cơ sở dữ liệu PostgreSQL (Supabase). Bạn có thể gõ <strong>Disconnect Docs</strong> trong Telegram để ngắt kết nối Google bất kỳ lúc nào — refresh token liên quan sẽ bị xoá khỏi hệ thống ngay lập tức. Muốn xoá toàn bộ dữ liệu tài khoản, liên hệ email ở mục 6.</p>

<h2>5. Bên thứ ba</h2>
<p>EdgeBook gọi các API: Telegram Bot API, Google APIs (Docs/Drive/Calendar — chỉ khi bạn chủ động kết nối), và một AI model provider để trả lời chat. Các bên này xử lý dữ liệu theo chính sách riêng của họ, chỉ trong phạm vi cần thiết để vận hành tính năng tương ứng.</p>

<h2>6. Liên hệ</h2>
<p>Câu hỏi về quyền riêng tư hoặc yêu cầu xoá dữ liệu, liên hệ: <a href="mailto:shincapitals@gmail.com">shincapitals@gmail.com</a></p>
</body></html>`;

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

export function startWebhookServer(sepayService: SepayService, bot: Bot, oauthService: GoogleOAuthService): void {
    const app = express();

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    app.get('/privacy', (_req, res) => {
        res.type('html').send(PRIVACY_POLICY_HTML);
    });

    // Google OAuth redirect — exchanges the code, stores the encrypted refresh token,
    // creates the user's research doc, then DMs them the doc link.
    app.get('/oauth/google/callback', async (req, res) => {
        const code = req.query.code as string | undefined;
        const state = req.query.state as string | undefined;
        const error = req.query.error as string | undefined;

        if (error || !code || !state) {
            return res.status(400).send(oauthResultPage(false, 'Kết nối bị huỷ hoặc thiếu thông tin.'));
        }

        try {
            const result = await oauthService.handleCallback(code, state);
            if (!result) {
                return res.status(400).send(oauthResultPage(false, 'Không xác thực được. Hãy thử Connect Docs lại.'));
            }

            res.send(oauthResultPage(true, 'Đã kết nối Google Docs!'));

            const docLink = result.docId ? `\n🔗 https://docs.google.com/document/d/${result.docId}/edit` : '';
            const who = result.email ? ` (${result.email})` : '';
            await bot.api.sendMessage(
                result.userId,
                `✅ Đã kết nối Google Docs${who}!\n` +
                `Mọi forward / Save: từ giờ sẽ tự được lưu vào Doc của bạn.${docLink}`,
                { link_preview_options: { is_disabled: true } },
            ).catch((err) => console.error(`OAuth connect DM failed for ${result.userId}:`, err));
        } catch (err) {
            console.error('OAuth callback error:', err);
            res.status(500).send(oauthResultPage(false, 'Có lỗi khi kết nối. Hãy thử lại sau.'));
        }
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
            } else if (result.status === 'trial_activated') {
                await bot.api.sendMessage(
                    result.userId,
                    `🎁 Trial Pro 7 ngày đã kích hoạt!\n\n` +
                    `⭐ Bạn được full quyền Pro trong 7 ngày: Unlimited forwards, Search & Tag, Daily Digest, Ask AI, Trade Journal, Watchlist & Alerts.\n\n` +
                    `Hết 7 ngày plan tự về Free (không tự động trừ tiền). Thích thì nâng cấp Pro tháng (99k) qua /upgrade.\n\n` +
                    `Gõ /plan để xem ngày hết hạn. Chúc trade may mắn! 🚀`
                ).catch(err => console.error(`Trial DM failed for ${result.userId}:`, err));
            } else if (result.status === 'trial_reused') {
                await bot.api.sendMessage(
                    result.userId,
                    `⚠️ Bạn đã từng dùng gói Trial 7 ngày rồi nên giao dịch ${result.amount.toLocaleString('vi-VN')}đ vừa rồi không được tính làm trial mới.\n\n` +
                    `Admin sẽ liên hệ hoàn lại tiền. Nếu muốn tiếp tục dùng Pro, gõ /upgrade và chọn Pro tháng (99k).`
                ).catch(err => console.error(`Trial reuse DM failed for ${result.userId}:`, err));
                await notifyAdmins(
                    bot,
                    `⚠️ SePay: user ${result.userId} chuyển ${result.amount.toLocaleString('vi-VN')}đ với mã TRI nhưng đã dùng trial trước đó (tx ${result.txId}).\n` +
                    `→ Cần hoàn tiền thủ công qua app ngân hàng.`
                );
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
