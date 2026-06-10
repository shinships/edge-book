import { pgTable, text, boolean, integer, real, bigint, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    username: text('username'),
    fullName: text('full_name'),
    jobTitle: text('job_title'),
    notes: text('notes').array().notNull(),
    activeDocId: text('active_doc_id'),
    docAliases: jsonb('doc_aliases').$type<Record<string, string>>().notNull(),
});

export const plans = pgTable('plans', {
    userId: bigint('user_id', { mode: 'number' }).primaryKey(),
    tier: text('tier').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    dailyForwardCount: integer('daily_forward_count').notNull(),
    lastResetDate: text('last_reset_date').notNull(),
    lsOrderId: text('ls_order_id').unique(),
    digestEnabled: boolean('digest_enabled').notNull().default(true),
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

export const todos = pgTable('todos', {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    task: text('task').notNull(),
    completed: boolean('completed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
