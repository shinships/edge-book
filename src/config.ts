import dotenv from 'dotenv';
import * as fs from 'fs';
// override: true → values in .env win over any pre-existing OS environment variables.
// Needed because an OS-level GOOGLE_APPLICATION_CREDENTIALS would otherwise silently
// shadow the project's .env and point the bot at a different service account.
dotenv.config({ override: true });

// --- Cloud/Railway: dựng service_account.json từ biến môi trường base64 ---
// Trên host ephemeral (Railway) không commit file SA; thay vào đó set GOOGLE_SA_BASE64
// (base64 của nội dung service_account.json). Nếu file chưa tồn tại, ghi ra từ env này
// để GoogleService (keyFile + fs.readFileSync) hoạt động như khi chạy local.
const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './service_account.json';
if (process.env.GOOGLE_SA_BASE64 && !fs.existsSync(saPath)) {
    try {
        fs.writeFileSync(saPath, Buffer.from(process.env.GOOGLE_SA_BASE64, 'base64').toString('utf-8'));
        console.log(`✅ Wrote service account credentials to ${saPath} from GOOGLE_SA_BASE64`);
    } catch (err) {
        console.error('Failed to write service account from GOOGLE_SA_BASE64:', err);
    }
}

export const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    vertexKeyApiKey: process.env.VERTEX_KEY_API_KEY || '',
    vertexKeyBaseUrl: process.env.VERTEX_KEY_BASE_URL || 'https://vertex-key.com/api/v1',
    chatModel: process.env.AI_CHAT_MODEL || 'aws/claude-sonnet-4-6-medium',   // Dùng cho chat AI
    fastModel: process.env.AI_FAST_MODEL || 'free/claude-haiku-4-5',    // Dùng cho task nhanh
    googleCredentials: saPath,
    googleDocId: process.env.GOOGLE_DOC_ID || '',
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '', // Required for Service Account uploads

    // Railway (và đa số PaaS) cấp cổng động qua PORT — ưu tiên PORT, fallback WEBHOOK_PORT, rồi 3000.
    webhookPort: parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10),

    // TODO(intl-payments): Re-add LemonSqueezy keys here when launching for international users.
    // Keys needed: LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_PRO_VARIANT_ID,
    // LEMONSQUEEZY_PREMIUM_VARIANT_ID, LEMONSQUEEZY_WEBHOOK_SECRET.
    // Restore payment.service.ts (removed in Sprint 15) and wire it back into index.ts + webhook.server.ts.

    // --- SePay Payment (VietQR bank transfer, for VN users) ---
    sepayAccountNumber: process.env.SEPAY_ACCOUNT_NUMBER || '',
    sepayBankCode: process.env.SEPAY_BANK_CODE || '',
    sepayAccountHolder: process.env.SEPAY_ACCOUNT_HOLDER || '',
    sepayApiKey: process.env.SEPAY_API_KEY || '',
    sepayProPriceVnd: parseInt(process.env.SEPAY_PRO_PRICE_VND || '199000', 10),
    sepayPremiumPriceVnd: parseInt(process.env.SEPAY_PREMIUM_PRICE_VND || '499000', 10),

    // --- Admin ---
    // Telegram user IDs with admin privileges (always treated as Premium).
    // Comma-separated in .env, e.g. ADMIN_USER_IDS=123,456
    adminUserIds: (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n)),

    // --- Database ---
    databaseUrl: process.env.DATABASE_URL || '',
};


if (!config.telegramBotToken) {
    console.error('Missing TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
}

if (!config.vertexKeyApiKey) {
    console.error('Missing VERTEX_KEY_API_KEY in .env');
    process.exit(1);
}

if (!config.sepayAccountNumber || !config.sepayBankCode || !config.sepayApiKey) {
    console.warn('⚠️  SEPAY_* not fully set — VietQR payment option will be disabled.');
}

