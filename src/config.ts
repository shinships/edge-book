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
};


if (!config.telegramBotToken) {
    console.error('Missing TELEGRAM_BOT_TOKEN in .env');
    process.exit(1);
}

if (!config.vertexKeyApiKey) {
    console.error('Missing VERTEX_KEY_API_KEY in .env');
    process.exit(1);
}

