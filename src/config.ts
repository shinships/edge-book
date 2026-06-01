import dotenv from 'dotenv';
dotenv.config();

export const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    vertexKeyApiKey: process.env.VERTEX_KEY_API_KEY || '',
    vertexKeyBaseUrl: process.env.VERTEX_KEY_BASE_URL || 'https://vertex-key.com/api/v1',
    chatModel: process.env.AI_CHAT_MODEL || 'aws/claude-sonnet-4-6',   // Dùng cho chat AI
    fastModel: process.env.AI_FAST_MODEL || 'aws/claude-haiku-4-5',    // Dùng cho task nhanh
    googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    googleDocId: process.env.GOOGLE_DOC_ID || '',
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '', // Required for Service Account uploads

    // --- LemonSqueezy Payment ---
    lsApiKey: process.env.LEMONSQUEEZY_API_KEY || '',
    lsStoreId: process.env.LEMONSQUEEZY_STORE_ID || '',
    lsProVariantId: process.env.LEMONSQUEEZY_PRO_VARIANT_ID || '',
    lsPremiumVariantId: process.env.LEMONSQUEEZY_PREMIUM_VARIANT_ID || '',
    lsWebhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
    webhookPort: parseInt(process.env.WEBHOOK_PORT || '3000', 10),

    // --- Admin ---
    // Telegram user IDs with admin privileges (always treated as Premium).
    // Comma-separated in .env, e.g. ADMIN_USER_IDS=123,456
    adminUserIds: (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n)),
};


if (!config.telegramBotToken) {
    console.error('Missing TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
}

if (!config.vertexKeyApiKey) {
    console.error('Missing VERTEX_KEY_API_KEY in .env');
    process.exit(1);
}

if (!config.lsApiKey) {
    console.warn('⚠️  LEMONSQUEEZY_API_KEY not set — /upgrade command will be disabled.');
}

