/**
 * One-time migration: JSON files → Supabase (PostgreSQL via Drizzle).
 * Run once after `npm run db:push`:  npm run db:seed
 *
 * Idempotent — uses onConflictDoNothing() so re-running is safe.
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { db } from '../db';
import { users, plans, researchItems, trades, theses, todos } from '../db/schema';

const DATA_DIR = path.resolve(__dirname, '../../data');

function readJson<T>(filename: string): T[] {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) {
        console.log(`  [skip] ${filename} not found`);
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as T[];
    } catch (e) {
        console.error(`  [error] reading ${filename}:`, e);
        return [];
    }
}

async function main() {
    console.log('=== EdgeBook JSON → DB migration ===\n');

    // --- Users ---
    const rawUsers = readJson<any>('users.json');
    let usersOk = 0;
    for (const u of rawUsers) {
        try {
            await db.insert(users).values({
                id: u.id,
                username: u.username,
                fullName: u.fullName,
                jobTitle: u.jobTitle,
                notes: u.notes ?? [],
                activeDocId: u.activeDocId,
                docAliases: u.docAliases ?? {},
            }).onConflictDoNothing();
            usersOk++;
        } catch (e) {
            console.error(`  [skip] user ${u.id}:`, e);
        }
    }
    console.log(`✅ Users: ${usersOk}/${rawUsers.length} migrated`);

    // --- Plans ---
    const rawPlans = readJson<any>('plans.json');
    let plansOk = 0;
    for (const p of rawPlans) {
        try {
            await db.insert(plans).values({
                userId: p.userId,
                tier: p.tier ?? 'free',
                expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
                dailyForwardCount: p.dailyForwardCount ?? 0,
                lastResetDate: p.lastResetDate ?? new Date().toISOString().split('T')[0],
                lsOrderId: p.lsOrderId,
            }).onConflictDoNothing();
            plansOk++;
        } catch (e) {
            console.error(`  [skip] plan for user ${p.userId}:`, e);
        }
    }
    console.log(`✅ Plans: ${plansOk}/${rawPlans.length} migrated`);

    // --- Research items ---
    const rawResearch = readJson<any>('research.json'); // [{userId, items:[...]}]
    let researchOk = 0, researchTotal = 0;
    for (const userEntry of rawResearch) {
        for (const item of (userEntry.items ?? [])) {
            researchTotal++;
            try {
                await db.insert(researchItems).values({
                    id: item.id,
                    userId: userEntry.userId,
                    content: item.content,
                    sourceName: item.sourceName,
                    sourceUrl: item.sourceUrl,
                    tickers: item.tickers ?? [],
                    categories: item.categories ?? [],
                    sentiment: item.sentiment ?? 0,
                    isStarred: item.isStarred ?? false,
                    googleDocId: item.googleDocId,
                    createdAt: new Date(item.createdAt),
                }).onConflictDoNothing();
                researchOk++;
            } catch (e) {
                console.error(`  [skip] research ${item.id}:`, e);
            }
        }
    }
    console.log(`✅ Research items: ${researchOk}/${researchTotal} migrated`);

    // --- Trades ---
    const rawTrades = readJson<any>('trades.json');
    let tradesOk = 0, tradesTotal = 0;
    for (const userEntry of rawTrades) {
        for (const item of (userEntry.items ?? [])) {
            tradesTotal++;
            try {
                await db.insert(trades).values({
                    id: item.id,
                    userId: userEntry.userId,
                    ticker: item.ticker,
                    direction: item.direction,
                    entryPrice: item.entryPrice,
                    stopLoss: item.stopLoss,
                    takeProfit: item.takeProfit,
                    exitPrice: item.exitPrice,
                    pnlPercent: item.pnlPercent,
                    status: item.status,
                    notes: item.notes,
                    linkedResearch: item.linkedResearch ?? [],
                    openedAt: new Date(item.openedAt),
                    closedAt: item.closedAt ? new Date(item.closedAt) : null,
                }).onConflictDoNothing();
                tradesOk++;
            } catch (e) {
                console.error(`  [skip] trade ${item.id}:`, e);
            }
        }
    }
    console.log(`✅ Trades: ${tradesOk}/${tradesTotal} migrated`);

    // --- Theses ---
    const rawTheses = readJson<any>('theses.json');
    let thesesOk = 0, thesesTotal = 0;
    for (const userEntry of rawTheses) {
        for (const item of (userEntry.items ?? [])) {
            thesesTotal++;
            try {
                await db.insert(theses).values({
                    id: item.id,
                    userId: userEntry.userId,
                    ticker: item.ticker,
                    stance: item.stance,
                    thesisText: item.text,
                    status: item.status,
                    conflictCount: item.conflictCount ?? 0,
                    createdAt: new Date(item.createdAt),
                    closedAt: item.closedAt ? new Date(item.closedAt) : null,
                }).onConflictDoNothing();
                thesesOk++;
            } catch (e) {
                console.error(`  [skip] thesis ${item.id}:`, e);
            }
        }
    }
    console.log(`✅ Theses: ${thesesOk}/${thesesTotal} migrated`);

    // --- Todos ---
    const rawTodos = readJson<any>('todos.json');
    let todosOk = 0, todosTotal = 0;
    for (const userEntry of rawTodos) {
        for (const item of (userEntry.items ?? [])) {
            todosTotal++;
            try {
                await db.insert(todos).values({
                    id: item.id,
                    userId: userEntry.userId,
                    task: item.task,
                    completed: item.completed ?? false,
                    createdAt: new Date(item.createdAt),
                }).onConflictDoNothing();
                todosOk++;
            } catch (e) {
                console.error(`  [skip] todo ${item.id}:`, e);
            }
        }
    }
    console.log(`✅ Todos: ${todosOk}/${todosTotal} migrated`);

    console.log('\n=== Migration complete ===');
    process.exit(0);
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
