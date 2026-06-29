import { pgTable, text, boolean, integer, real, bigint, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    username: text('username'),
    fullName: text('full_name'),
    jobTitle: text('job_title'),
    notes: text('notes').array().notNull(),
    activeDocId: text('active_doc_id'),
    docAliases: jsonb('doc_aliases').$type<Record<string, string>>().notNull(),
    acquisitionSource: text('acquisition_source'),
    docsHintDismissed: boolean('docs_hint_dismissed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
});

export const plans = pgTable('plans', {
    userId: bigint('user_id', { mode: 'number' }).primaryKey(),
    tier: text('tier').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    dailyForwardCount: integer('daily_forward_count').notNull(),
    dailyChatCount: integer('daily_chat_count').notNull().default(0),
    lastResetDate: text('last_reset_date').notNull(),
    lsOrderId: text('ls_order_id').unique(),
    sepayTxId: text('sepay_tx_id').unique(),
    digestEnabled: boolean('digest_enabled').notNull().default(true),
    trialUsedAt: timestamp('trial_used_at', { withTimezone: true }),
});

export const researchItems = pgTable('research_items', {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    content: text('content').notNull(),
    sourceName: text('source_name'),
    sourceUrl: text('source_url'),
    tickers: text('tickers').array().notNull(),
    categories: text('categories').array().notNull(),
    sentiment: real('sentiment').notNull(),
    isStarred: boolean('is_starred').notNull(),
    googleDocId: text('google_doc_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const trades = pgTable('trades', {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    ticker: text('ticker').notNull(),
    direction: text('direction').notNull(),
    entryPrice: real('entry_price').notNull(),
    stopLoss: real('stop_loss'),
    takeProfit: real('take_profit'),
    exitPrice: real('exit_price'),
    pnlPercent: real('pnl_percent'),
    status: text('status').notNull(),
    notes: text('notes'),
    linkedResearch: text('linked_research').array().notNull(),
    positionSize: real('position_size'),
    riskPercent: real('risk_percent'),
    feePercent: real('fee_percent'),
    closeReason: text('close_reason'),   // 'tp' | 'sl' | 'manual'
    setupTag: text('setup_tag'),
    emotionScore: integer('emotion_score'),   // 1-10 self-rated state at entry
    heartRate: integer('heart_rate'),         // bpm at entry (optional, smartwatch)
    disciplined: boolean('disciplined'),      // null = not audited, true = followed plan, false = violated
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const theses = pgTable('theses', {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    ticker: text('ticker').notNull(),
    stance: text('stance').notNull(),
    thesisText: text('thesis_text').notNull(),
    status: text('status').notNull(),
    conflictCount: integer('conflict_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const alerts = pgTable('alerts', {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    ticker: text('ticker').notNull(),
    condition: text('condition').notNull(),           // 'above' | 'below' (direction; also stance for foreign/rsi)
    targetPrice: real('target_price').notNull(),      // price target, or threshold (rsi level / volume multiple)
    // 'price' (intraday) | 'foreign' | 'volume' | 'rsi' | 'macross' (EOD, VN stocks)
    alertType: text('alert_type').notNull().default('price'),
    params: jsonb('params').$type<Record<string, any>>(),
    status: text('status').notNull(),                 // 'active' | 'triggered'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }),
});

export const watchlistItems = pgTable('watchlist_items', {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    ticker: text('ticker').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('watchlist_user_ticker_idx').on(t.userId, t.ticker)]);

export const disciplineState = pgTable('discipline_state', {
    userId: bigint('user_id', { mode: 'number' }).primaryKey(),
    enabled: boolean('enabled').notNull().default(true),
    lossStreak: integer('loss_streak').notNull().default(0),
    lossDate: text('loss_date'),                      // VN-timezone date string the loss counter belongs to
    lossesToday: integer('losses_today').notNull().default(0),
    dailyLossLimit: integer('daily_loss_limit').notNull().default(3),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
});

// Real position ledger (distinct from `trades`, which is a journal of entries/exits).
// One row per user+ticker; quantity & avgCost track the live holding, realizedPnl the
// cumulative booked profit from partial/full sells. Prices in native units (VN: thousand
// VND, crypto: USD) consistent with MarketRouter.
export const portfolioPositions = pgTable('portfolio_positions', {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    ticker: text('ticker').notNull(),
    quantity: real('quantity').notNull(),
    avgCost: real('avg_cost').notNull(),
    market: text('market').notNull(),                          // 'vn' | 'crypto'
    realizedPnl: real('realized_pnl').notNull().default(0),    // money units (qty * price)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('portfolio_user_ticker_idx').on(t.userId, t.ticker)]);

export const referrals = pgTable('referrals', {
    id: text('id').primaryKey(),
    referrerId: bigint('referrer_id', { mode: 'number' }).notNull(),
    refereeId: bigint('referee_id', { mode: 'number' }).notNull().unique(),
    status: text('status').notNull(),   // 'pending' | 'rewarded'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    rewardedAt: timestamp('rewarded_at', { withTimezone: true }),
});

// Per-user Google OAuth credentials. One row/user. The refresh token is stored
// AES-256-GCM encrypted (never plaintext). `docId` is the "EdgeBook Research" doc
// the bot created in the user's own Drive on first connect.
export const googleOauthTokens = pgTable('google_oauth_tokens', {
    userId: bigint('user_id', { mode: 'number' }).primaryKey(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),   // format: iv:authTag:ciphertext (base64)
    docId: text('doc_id'),                                  // ACTIVE doc — research appends here
    docs: jsonb('docs').$type<{ id: string; name: string }[]>(),  // all docs the bot created for this user
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const todos = pgTable('todos', {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    task: text('task').notNull(),
    completed: boolean('completed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
