import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config';
import { AIService } from './services/ai.service';
import { GoogleService } from './services/google.service';
import { UserService } from './services/user.service';
import { TodoService } from './services/todo.service';
import { ResearchService } from './services/research.service';
import { PlanService } from './services/plan.service';
import { PaymentService } from './services/payment.service';
import { TradeService } from './services/trade.service';
import { ReportService } from './services/report.service';
import { ThesisService, ThesisItem } from './services/thesis.service';
import { startWebhookServer } from './webhook.server';
import fs from 'fs';
import https from 'https';
import cron from 'node-cron';

const bot = new Bot(config.telegramBotToken);
const aiService = new AIService();
const googleService = new GoogleService();
const todoService = new TodoService();
const userService = new UserService();
const researchService = new ResearchService();
const planService = new PlanService(config.adminUserIds);
const paymentService = new PaymentService(planService);
const tradeService = new TradeService();
const reportService = new ReportService();
const thesisService = new ThesisService();

// Parse a positive price string that may use a "k" suffix (e.g. "108k" -> 108000).
// Returns undefined for malformed input (e.g. "1.2.3", ".", "0", negatives).
function parsePrice(raw?: string): number | undefined {
    if (!raw) return undefined;
    const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k?)$/);
    if (!m) return undefined;
    const value = parseFloat(m[1]);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return m[2] === 'k' ? value * 1000 : value;
}

// Parse a signed percent string like "+3.2%", "-2%" (no "k" suffix allowed).
function parsePercent(raw?: string): number | undefined {
    if (!raw) return undefined;
    const m = raw.trim().match(/^([+-]?\d+(?:\.\d+)?)%$/);
    if (!m) return undefined;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : undefined;
}

// Validate a ticker: alphanumerics with one optional . / - separator (e.g. BTC,
// BRK.B, ETH/USDT, BTC-PERP). Must contain at least one letter (rejects "123").
function isValidTicker(raw: string): boolean {
    return /^[A-Za-z0-9]{1,10}(?:[./-][A-Za-z0-9]{1,10})?$/.test(raw) && /[A-Za-z]/.test(raw);
}

// Format a percent with an explicit sign (e.g. +3.2%, -2%, 0%).
function fmtPct(n: number): string {
    return `${n > 0 ? '+' : ''}${n}%`;
}

// Format a price for display (compact "k" notation for large round-ish numbers)
function formatPrice(value: number): string {
    if (value >= 1000) {
        const k = value / 1000;
        return `${Number.isInteger(k) ? k : k.toFixed(2).replace(/\.?0+$/, '')}k`;
    }
    return `${value}`;
}

// Build a short, single-line preview label for a research item (for inline buttons).
function researchLabel(content: string, max = 40): string {
    const oneLine = content.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

// Format an average hold duration (in hours) for display: "45m", "3.5h", "2d 4h".
// Rounds the total first and normalizes the 24h boundary so it never emits
// impossible values like "24h" (→ "1d") or "1d 24h" (→ "2d").
function formatHold(hours: number): string {
    const totalMinutes = Math.round(hours * 60);
    if (totalMinutes < 60) return `${totalMinutes}m`;

    const totalHours = totalMinutes / 60;
    if (totalHours < 24) {
        const h = Math.round(totalHours * 10) / 10;
        if (h < 24) return `${h}h`;   // rounds up to 24 → fall through to days
    }

    const days = Math.floor(totalMinutes / 1440);
    const remHours = Math.round((totalMinutes % 1440) / 60);
    if (remHours === 24) return `${days + 1}d`;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

// Strip Vietnamese diacritics to plain ASCII (pdfkit built-in fonts can't render them).
function toAscii(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')    // combining diacritics
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .replace(/[^\x20-\x7e]/g, '')       // drop any remaining non-ASCII
        .trim();
}

// Telegram Bot API 7.0 (Dec 2023) removed forward_date/forward_from/forward_from_chat/
// forward_sender_name in favour of a single `forward_origin` object. Detect forwards and
// extract the original source name from whichever origin variant is present.
function isForwarded(message: any): boolean {
    return message?.forward_origin !== undefined;
}

// Build a clickable Google Docs URL from a document ID.
function docUrl(docId: string): string {
    return `https://docs.google.com/document/d/${docId}/edit`;
}

function getForwardSource(message: any): string | undefined {
    const origin = message?.forward_origin;
    if (!origin) return undefined;
    switch (origin.type) {
        case 'user':         return origin.sender_user?.first_name;
        case 'hidden_user':  return origin.sender_user_name;
        case 'chat':         return origin.sender_chat?.title;
        case 'channel':      return origin.chat?.title;
        default:             return undefined;
    }
}

// Basic Command Handlers
bot.command('start', (ctx) => ctx.reply(
    '👋 EdgeBook · capture your edge.\n' +
    'Research OS cho trader, sống ngay trong Telegram.\n' +
    '\n' +
    '✨ Nổi bật:\n' +
    '📥 Forward tin → tự gắn tag ticker, chấm sentiment & lưu Docs\n' +
    '📊 Daily Digest + Weekly Report tổng hợp research bằng AI\n' +
    '🔍 Search & Ask: hỏi AI ngay trên kho research của bạn\n' +
    '📈 Trade Journal: log lệnh, tính PnL, win rate, analytics\n' +
    '🧠 Thesis tracker: cảnh báo khi tin mới mâu thuẫn luận điểm\n' +
    '\n' +
    'Gõ /help để xem tất cả lệnh.'
));

bot.command('help', (ctx) => {
    ctx.reply(
        '📓 EdgeBook · các lệnh chính\n' +
        '\n' +
        '💬 Chat & cá nhân hoá\n' +
        '• Nhắn bất kỳ để hỏi AI\n' +
        '• Call me [tên] · My job is [nghề]\n' +
        '\n' +
        '📂 Docs\n' +
        '• Add Doc [tên] [ID] · Use Doc [tên] · Current Doc\n' +
        '\n' +
        '💾 Lưu nội dung\n' +
        '• Save: [nội dung], hoặc forward tin/ảnh → lưu Docs\n' +
        '\n' +
        '✅ To-Do & lịch\n' +
        '• Add Task: [việc] · List Tasks · Complete Task: [số]\n' +
        '• Remind me… → tạo nhắc lịch\n' +
        '\n' +
        '📊 Research OS (Pro)\n' +
        '• Forward tin → tự gắn tag ticker\n' +
        '• Search: · Tag: · Digest · Weekly Report · Ask:\n' +
        '• Stats · Starred\n' +
        '• Thesis: [ticker] [bullish|bearish] [ý] → cảnh báo tin mâu thuẫn (Premium)\n' +
        '• Theses · Close Thesis: [số]\n' +
        '\n' +
        '📈 Trade Journal (Pro)\n' +
        '• Trade: Long BTC entry 108k SL 105k TP 115k → mở lệnh\n' +
        '• Close: BTC 112k · Close: BTC +3.2% → đóng lệnh\n' +
        '• Trades · Trade Stats\n' +
        '• Trade Analytics · Export PDF (Premium)\n' +
        '\n' +
        '💳 Tài khoản\n' +
        '• /plan · /upgrade'
    );
});

// General Chat Handler
bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from?.id;

    // Show typing status
    await ctx.replyWithChatAction('typing');

    if (!userId) {
        await ctx.reply('Error: Unknown User ID.');
        return;
    }

    // --- DOCS MANAGEMENT COMMANDS ---
    // "Add Doc [Alias] [ID]"
    const addDocMatch = text.match(/^add doc\s+(\S+)\s+(\S+)/i);
    if (addDocMatch) {
        const alias = addDocMatch[1];
        const docId = addDocMatch[2];
        userService.setDocAlias(userId, alias, docId);
        await ctx.reply(`✅ Added Doc "${alias}". Set as default if none existed.`);
        return;
    }

    // "Use Doc [Alias/ID]"
    const setDocMatch = text.match(/^use doc\s+(\S+)/i); // or "Select Doc"
    if (setDocMatch) {
        const alias = setDocMatch[1];
        if (userService.setActiveDoc(userId, alias)) {
            await ctx.reply(`✅ Switched to Doc: ${alias}`);
        } else {
            await ctx.reply(`⚠️ Doc "${alias}" not found. Use Add Doc first.`);
        }
        return;
    }

    // "Current Doc"
    if (text.toLowerCase() === 'current doc') {
        const activeId = userService.getActiveDocId(userId);
        if (activeId) {
            const alias = userService.getActiveDocAlias(userId);
            const aliasLine = alias ? `\n🏷️ Alias: ${alias}` : '';
            await ctx.reply(
                `📂 Current Doc${aliasLine}\n🆔 ${activeId}\n🔗 ${docUrl(activeId)}`,
                { link_preview_options: { is_disabled: true } }
            );
        } else if (config.googleDocId) {
            await ctx.reply(
                `📂 Current Doc: system default\n🆔 ${config.googleDocId}\n🔗 ${docUrl(config.googleDocId)}`,
                { link_preview_options: { is_disabled: true } }
            );
        } else {
            await ctx.reply('📂 No Doc configured yet. Use Add Doc [name] [ID] to add one.');
        }
        return;
    }

    // ---------------------------

    // --- TO-DO LIST COMMANDS ---
    if (text.toLowerCase().startsWith('add task:')) {
        const task = text.substring(9).trim(); // "add task:".length = 9
        if (task) {
            todoService.addTodo(userId, task);
            await ctx.reply(`Added task: "${task}"`);
            return;
        }
    }

    if (text.toLowerCase() === 'list tasks' || text.toLowerCase() === 'todo list') {
        const items = todoService.getTodos(userId).filter(i => !i.completed);
        if (items.length === 0) {
            await ctx.reply('You have no pending tasks.');
        } else {
            const list = items.map((i, idx) => `${idx + 1}. ${i.task}`).join('\n');
            await ctx.reply(`Your To-Do List:\n${list}`);
        }
        return;
    }

    if (text.toLowerCase().startsWith('complete task:')) {
        const keyword = text.substring(14).trim(); // "complete task:".length = 14
        if (keyword) {
            const completedItem = todoService.completeTodo(userId, keyword);
            if (completedItem) {
                await ctx.reply(`Marked as done: "${completedItem.task}"`);
            } else {
                await ctx.reply('Task not found.');
            }
            return;
        }
    }
    // ---------------------------

    // --- RESEARCH OS COMMANDS ---

    // "Search: <keyword>" — search saved research
    if (text.toLowerCase().startsWith('search:')) {
        const keyword = text.substring(7).trim();
        if (!keyword) {
            await ctx.reply('⚠️ Vui lòng nhập keyword. Ví dụ: Search: BTC');
            return;
        }

        // Check plan
        if (!planService.canUse(userId, 'canSearch')) {
            await ctx.reply('🔒 Search là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        const results = researchService.searchByKeyword(userId, keyword);
        if (results.length === 0) {
            await ctx.reply(`🔍 Không tìm thấy research nào chứa "${keyword}".`);
        } else {
            const display = results.slice(-10).map((item, idx) => {
                const date = new Date(item.createdAt).toLocaleDateString('vi-VN');
                const star = item.isStarred ? '⭐ ' : '';
                const tickers = item.tickers.length > 0 ? ` [${item.tickers.join(', ')}]` : '';
                const source = item.sourceName ? ` (${item.sourceName})` : '';
                return `${star}${idx + 1}. ${date}${source}${tickers}\n   ${item.content.substring(0, 150)}${item.content.length > 150 ? '...' : ''}`;
            }).join('\n\n');
            await ctx.reply(`🔍 Tìm thấy ${results.length} kết quả cho "${keyword}":\n\n${display}`);
        }
        return;
    }

    // "Tag: <ticker>" — find all research for a ticker
    if (text.toLowerCase().startsWith('tag:')) {
        const ticker = text.substring(4).trim().toUpperCase();
        if (!ticker) {
            await ctx.reply('⚠️ Vui lòng nhập ticker. Ví dụ: Tag: BTC');
            return;
        }

        if (!planService.canUse(userId, 'canSearch')) {
            await ctx.reply('🔒 Search/Tag là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        const results = researchService.searchByTicker(userId, ticker);
        if (results.length === 0) {
            await ctx.reply(`🏷️ Không có research nào tagged ${ticker}.`);
        } else {
            const display = results.slice(-10).map((item, idx) => {
                const date = new Date(item.createdAt).toLocaleDateString('vi-VN');
                const star = item.isStarred ? '⭐ ' : '';
                const sentiment = item.sentiment > 0.2 ? '🟢' : item.sentiment < -0.2 ? '🔴' : '🟡';
                const source = item.sourceName ? ` (${item.sourceName})` : '';
                return `${star}${sentiment} ${idx + 1}. ${date}${source}\n   ${item.content.substring(0, 150)}${item.content.length > 150 ? '...' : ''}`;
            }).join('\n\n');
            await ctx.reply(`🏷️ ${ticker}: ${results.length} research items:\n\n${display}`);
        }
        return;
    }

    // "Digest" — manually trigger daily digest
    if (text.toLowerCase() === 'digest' || text.toLowerCase() === 'daily digest') {
        if (!planService.canUse(userId, 'canDigest')) {
            await ctx.reply('🔒 Daily Digest là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const digestData = researchService.getDigestData(userId, 24);
        const digest = await aiService.generateDigest(digestData);
        await ctx.reply(digest);
        return;
    }

    // "Weekly Report" — 7-day report with sentiment shift (Pro)
    if (
        text.toLowerCase() === 'weekly report' ||
        text.toLowerCase() === 'weekly' ||
        text.toLowerCase() === 'weekly digest'
    ) {
        if (!planService.canUse(userId, 'canDigest')) {
            await ctx.reply('🔒 Weekly Report là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const weeklyData = researchService.getWeeklyReportData(userId);
        const report = await aiService.generateWeeklyReport(weeklyData);
        await ctx.reply(report);
        return;
    }

    // "Stats" — research stats
    if (text.toLowerCase() === 'stats' || text.toLowerCase() === 'research stats') {
        const stats = researchService.getStats(userId);
        if (stats.totalItems === 0) {
            await ctx.reply('📊 Chưa có research nào. Forward messages vào bot để bắt đầu!');
            return;
        }

        const topTickers = stats.topTickers.slice(0, 5).map(t => `  ${t.ticker}: ${t.count}`).join('\n');
        await ctx.reply(
            `📊 Research Stats\n\n` +
            `📦 Tổng: ${stats.totalItems} items\n` +
            `⭐ Starred: ${stats.starredCount}\n` +
            `📅 Hôm nay: ${stats.todayCount}\n` +
            `📅 Tuần này: ${stats.thisWeekCount}\n\n` +
            `🔥 Top Tickers:\n${topTickers || '  (chưa có)'}`
        );
        return;
    }

    // "Starred" — view starred/bookmarked items
    if (text.toLowerCase() === 'starred' || text.toLowerCase() === 'bookmarks') {
        const starred = researchService.getStarredItems(userId);
        if (starred.length === 0) {
            await ctx.reply('⭐ Chưa có bookmark nào. Reply ⭐ hoặc gõ Star để bookmark research gần nhất.');
            return;
        }

        const display = starred.slice(-10).map((item, idx) => {
            const date = new Date(item.createdAt).toLocaleDateString('vi-VN');
            const tickers = item.tickers.length > 0 ? ` [${item.tickers.join(', ')}]` : '';
            const source = item.sourceName ? ` (${item.sourceName})` : '';
            return `⭐ ${idx + 1}. ${date}${source}${tickers}\n   ${item.content.substring(0, 150)}${item.content.length > 150 ? '...' : ''}`;
        }).join('\n\n');
        await ctx.reply(`⭐ Bookmarks (${starred.length}):\n\n${display}`);
        return;
    }

    // "Star" — star the most recent research item
    if (text.toLowerCase() === 'star' || text.toLowerCase() === '⭐') {
        const starred = researchService.starLatest(userId);
        if (starred) {
            await ctx.reply(`⭐ Đã bookmark: "${starred.content.substring(0, 80)}..."`);
        } else {
            await ctx.reply('⚠️ Không có research nào để bookmark.');
        }
        return;
    }

    // "Ask: <question>" — ask AI about saved research
    if (text.toLowerCase().startsWith('ask:')) {
        const question = text.substring(4).trim();
        if (!question) {
            await ctx.reply('⚠️ Vui lòng nhập câu hỏi. Ví dụ: Ask: BTC tuần này có gì đáng chú ý?');
            return;
        }

        if (!planService.canUse(userId, 'canSearch')) {
            await ctx.reply('🔒 Research Q&A là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const items = researchService.getItems(userId);
        const answer = await aiService.askAboutResearch(question, items);
        await ctx.reply(`🤖 Research AI:\n\n${answer}`);
        return;
    }

    // "/plan" — show current plan info
    if (text.toLowerCase() === '/plan' || text.toLowerCase() === 'my plan') {
        const info = planService.getPlanInfo(userId);
        await ctx.reply(info);
        return;
    }

    // "Close Thesis: <index|ticker>" — close an active thesis (Premium)
    if (text.toLowerCase().startsWith('close thesis:')) {
        if (!planService.canUse(userId, 'canThesis')) {
            await ctx.reply('🔒 Thesis Tracker là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const selector = text.slice(text.indexOf(':') + 1).trim();
        if (!selector) {
            await ctx.reply('⚠️ Cú pháp: Close Thesis: <số thứ tự hoặc ticker>. Gõ Theses để xem danh sách.');
            return;
        }
        const closed = thesisService.closeThesis(userId, selector);
        if (!closed) {
            await ctx.reply(`⚠️ Không tìm thấy thesis "${selector}". Gõ Theses để xem danh sách.`);
            return;
        }
        const e = closed.stance === 'bullish' ? '📈' : '📉';
        await ctx.reply(`✅ Đã đóng thesis ${e} ${closed.ticker} (${closed.stance}).`);
        return;
    }

    // "Thesis: <ticker> <bullish|bearish> <text>" — record a thesis (Premium)
    if (text.toLowerCase().startsWith('thesis:')) {
        if (!planService.canUse(userId, 'canThesis')) {
            await ctx.reply('🔒 Thesis Tracker là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const usage = '⚠️ Cú pháp: Thesis: <ticker> <bullish|bearish> <luận điểm>\nVí dụ: Thesis: BTC bullish 150k EOY, S2F on track';
        const m = text.slice(text.indexOf(':') + 1).trim().match(/^(\S+)\s+(bullish|bearish|long|short)\s+(.+)$/i);
        if (!m) {
            await ctx.reply(usage);
            return;
        }
        const rawTicker = m[1];
        if (!isValidTicker(rawTicker)) {
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: BTC, ETH, SOL`);
            return;
        }
        const word = m[2].toLowerCase();
        const stance: 'bullish' | 'bearish' = (word === 'bullish' || word === 'long') ? 'bullish' : 'bearish';
        const thesis = thesisService.addThesis(userId, rawTicker, stance, m[3]);
        const e = stance === 'bullish' ? '📈' : '📉';
        await ctx.reply(
            `${e} Đã ghi thesis ${thesis.ticker} (${stance}):\n"${thesis.text}"\n\n` +
            `🔔 Mình sẽ nhắc khi có research mâu thuẫn với luận điểm này.`
        );
        return;
    }

    // "Theses" / "My Theses" — list active theses (Premium)
    if (text.toLowerCase() === 'theses' || text.toLowerCase() === 'my theses') {
        if (!planService.canUse(userId, 'canThesis')) {
            await ctx.reply('🔒 Thesis Tracker là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const active = thesisService.getActiveTheses(userId);
        if (active.length === 0) {
            await ctx.reply('📋 Chưa có thesis nào. Ghi mới: Thesis: BTC bullish 150k EOY');
            return;
        }
        let msg = '📋 Theses đang theo dõi:\n';
        active.forEach((t, i) => {
            const e = t.stance === 'bullish' ? '📈' : '📉';
            const conflict = t.conflictCount > 0 ? ` ⚠️${t.conflictCount}` : '';
            msg += `\n${i + 1}. ${e} ${t.ticker} (${t.stance})${conflict}\n   "${t.text}"`;
        });
        msg += '\n\n💡 Đóng thesis: Close Thesis: <số thứ tự>';
        await ctx.reply(msg);
        return;
    }

    // --- END RESEARCH OS COMMANDS ---

    // --- TRADE JOURNAL COMMANDS (Pro) ---

    // Trade: Long BTC entry 108k SL 105k TP 115k
    if (text.toLowerCase().startsWith('trade:')) {
        if (!planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const tradeUsage =
            '⚠️ Sai cú pháp. Ví dụ: Trade: Long BTC entry 108k SL 105k TP 115k';
        const m = text.slice(text.indexOf(':') + 1).trim().match(/^(long|short)\s+(\S+)\s+(.+)$/i);
        if (!m) {
            await ctx.reply(tradeUsage);
            return;
        }
        const direction = m[1].toLowerCase() as 'long' | 'short';
        const rawTicker = m[2];
        if (!isValidTicker(rawTicker)) {
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: BTC, ETH/USDT, BTC-PERP`);
            return;
        }
        const ticker = rawTicker.toUpperCase();
        const rest = m[3];
        const entry = parsePrice(rest.match(/entry\s*(\S+)/i)?.[1]);
        const sl = parsePrice(rest.match(/sl\s*(\S+)/i)?.[1]);
        const tp = parsePrice(rest.match(/tp\s*(\S+)/i)?.[1]);
        if (entry === undefined) {
            await ctx.reply('⚠️ Thiếu hoặc sai giá entry. ' + tradeUsage);
            return;
        }
        const trade = tradeService.openTrade(userId, {
            ticker,
            direction,
            entryPrice: entry,
            stopLoss: sl,
            takeProfit: tp,
        });
        if (!trade) {
            await ctx.reply('⚠️ Không thể mở lệnh: giá không hợp lệ.');
            return;
        }
        const dirEmoji = direction === 'long' ? '🟢' : '🔴';
        // Warn on a reversed-logic setup (e.g. long with TP below entry)
        const reversed =
            (sl !== undefined && tp !== undefined) &&
            (direction === 'long' ? !(tp > entry && sl < entry) : !(tp < entry && sl > entry));
        await ctx.reply(
            `${dirEmoji} Đã mở lệnh ${direction.toUpperCase()} ${trade.ticker}\n` +
            `Entry: ${formatPrice(trade.entryPrice)}` +
            (trade.stopLoss !== undefined ? `\nSL: ${formatPrice(trade.stopLoss)}` : '') +
            (trade.takeProfit !== undefined ? `\nTP: ${formatPrice(trade.takeProfit)}` : '') +
            (reversed ? '\n⚠️ SL/TP ngược chiều với hướng lệnh, sẽ không tính RR.' : '')
        );
        return;
    }

    // Close: BTC 112k  |  Close: BTC +3.2%
    if (text.toLowerCase().startsWith('close:')) {
        if (!planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const closeUsage = '⚠️ Sai cú pháp. Ví dụ: Close: BTC 112k  hoặc  Close: BTC +3.2%';
        const m = text.slice(text.indexOf(':') + 1).trim().match(/^(\S+)\s+(\S+)$/);
        if (!m) {
            await ctx.reply(closeUsage);
            return;
        }
        const rawTicker = m[1];
        if (!isValidTicker(rawTicker)) {
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ.`);
            return;
        }
        const ticker = rawTicker.toUpperCase();
        const rawValue = m[2];
        let exit: { price?: number; percent?: number };
        if (rawValue.includes('%')) {
            const percent = parsePercent(rawValue);
            if (percent === undefined) {
                await ctx.reply('⚠️ Phần trăm không hợp lệ. ' + closeUsage);
                return;
            }
            exit = { percent };
        } else {
            const price = parsePrice(rawValue);
            if (price === undefined) {
                await ctx.reply('⚠️ Giá exit không hợp lệ. ' + closeUsage);
                return;
            }
            exit = { price };
        }
        const closed = tradeService.closeTrade(userId, ticker, exit);
        if (!closed) {
            await ctx.reply(`⚠️ Không tìm thấy lệnh open nào cho ${ticker}.`);
            return;
        }
        const pnl = closed.pnlPercent ?? 0;
        const emoji = pnl > 0 ? '✅' : '❌';
        await ctx.reply(
            `${emoji} Đã đóng ${closed.direction.toUpperCase()} ${closed.ticker}\n` +
            `Entry: ${formatPrice(closed.entryPrice)} → Exit: ${formatPrice(closed.exitPrice!)}\n` +
            `PnL: ${fmtPct(pnl)}`
        );

        // Research-to-trade link (Premium): offer to link recent research on this ticker.
        if (planService.canUse(userId, 'canLinkResearch')) {
            // Prefer items matching the ticker; fall back to the most recent research.
            const alreadyLinked = new Set(closed.linkedResearch ?? []);
            let candidates = researchService
                .searchByTicker(userId, closed.ticker)
                .filter((r) => !alreadyLinked.has(r.id));
            if (candidates.length === 0) {
                candidates = researchService
                    .getRecentItems(userId, 24 * 7)
                    .filter((r) => !alreadyLinked.has(r.id));
            }
            // Most recent first, cap at 5 to keep the keyboard tidy.
            candidates = candidates.slice(-5).reverse();
            if (candidates.length > 0) {
                const keyboard = new InlineKeyboard();
                candidates.forEach((r) => {
                    keyboard.text(`🔗 ${researchLabel(r.content)}`, `linkres:${closed.id}:${r.id}`).row();
                });
                keyboard.text('Bỏ qua', `linkres_skip:${closed.id}`);
                await ctx.reply('🔗 Link lệnh này tới research nào?', { reply_markup: keyboard });
            }
        }
        return;
    }

    // Trades / My Trades
    if (text.toLowerCase() === 'trades' || text.toLowerCase() === 'my trades') {
        if (!planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const open = tradeService.getOpenTrades(userId);
        const closed = tradeService.getClosedTrades(userId).slice(-5).reverse();
        if (open.length === 0 && closed.length === 0) {
            await ctx.reply('📒 Chưa có lệnh nào. Mở lệnh: Trade: Long BTC entry 108k SL 105k TP 115k');
            return;
        }
        let msg = '📒 Trade Journal\n';
        const linkTag = (t: typeof open[number]) => {
            const n = t.linkedResearch?.length ?? 0;
            return n > 0 ? ` 🔗${n}` : '';
        };
        if (open.length > 0) {
            msg += '\n🔵 Open:\n';
            open.forEach((t) => {
                const e = t.direction === 'long' ? '🟢' : '🔴';
                msg += `${e} ${t.direction.toUpperCase()} ${t.ticker} @ ${formatPrice(t.entryPrice)}${linkTag(t)}\n`;
            });
        }
        if (closed.length > 0) {
            msg += '\n⚪ Closed (gần đây):\n';
            closed.forEach((t) => {
                const pnl = t.pnlPercent ?? 0;
                const e = pnl > 0 ? '✅' : '❌';
                msg += `${e} ${t.direction.toUpperCase()} ${t.ticker}: ${fmtPct(pnl)}${linkTag(t)}\n`;
            });
        }
        await ctx.reply(msg);
        return;
    }

    // Trade Stats
    if (text.toLowerCase() === 'trade stats') {
        if (!planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const s = tradeService.getStats(userId);
        if (s.closed === 0) {
            await ctx.reply('📊 Chưa có lệnh đã đóng nào để thống kê.');
            return;
        }
        let msg =
            '📊 Trade Stats\n\n' +
            `Tổng lệnh: ${s.total} (open ${s.open}, closed ${s.closed})\n` +
            `Win rate: ${s.winRate}% (${s.wins}W / ${s.losses}L)\n` +
            `Tổng PnL: ${fmtPct(s.totalPnl)}\n` +
            `Avg RR (planned): ${s.avgRR}`;
        if (s.best) msg += `\nBest: ${s.best.ticker} ${fmtPct(s.best.pnlPercent ?? 0)}`;
        if (s.worst) msg += `\nWorst: ${s.worst.ticker} ${fmtPct(s.worst.pnlPercent ?? 0)}`;
        await ctx.reply(msg);
        return;
    }

    // Trade Analytics / Performance (Premium) — breakdown by ticker/direction/month + AI insight
    if (
        text.toLowerCase() === 'trade analytics' ||
        text.toLowerCase() === 'analytics' ||
        text.toLowerCase() === 'performance'
    ) {
        if (!planService.canUse(userId, 'canAnalytics')) {
            await ctx.reply('🔒 Performance Analytics là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const a = tradeService.getAnalytics(userId);
        if (a.closedCount === 0) {
            await ctx.reply('📊 Chưa có lệnh đã đóng nào để phân tích. Đóng vài lệnh trước nhé!');
            return;
        }

        let msg = '📈 Performance Analytics\n\n';
        msg += `Lệnh đã đóng: ${a.closedCount}\n`;
        if (a.avgHoldHours !== null) msg += `⏱ Giữ lệnh TB: ${formatHold(a.avgHoldHours)}\n`;

        msg += '\n🏆 Theo ticker:\n';
        a.byTicker.slice(0, 10).forEach((t) => {
            const e = t.totalPnl > 0 ? '✅' : '❌';
            msg += `${e} ${t.ticker}: ${t.trades} lệnh · win ${t.winRate}% · ${fmtPct(t.totalPnl)}\n`;
        });

        if (a.byDirection.length > 0) {
            msg += '\n↕️ Theo hướng:\n';
            a.byDirection.forEach((d) => {
                const e = d.direction === 'long' ? '🟢' : '🔴';
                msg += `${e} ${d.direction.toUpperCase()}: ${d.trades} lệnh · win ${d.winRate}% · ${fmtPct(d.totalPnl)}\n`;
            });
        }

        msg += '\n🗓 Theo tháng:\n';
        a.byMonth.forEach((m) => {
            const e = m.totalPnl > 0 ? '✅' : '❌';
            msg += `${e} ${m.month}: ${m.trades} lệnh · win ${m.winRate}% · ${fmtPct(m.totalPnl)}\n`;
        });

        await ctx.reply(msg);

        // AI insight (best-effort — skipped silently if it fails)
        await ctx.replyWithChatAction('typing');
        const insight = await aiService.generateTradeInsight(a);
        if (insight) {
            await ctx.reply(`🤖 AI insight:\n\n${insight}`);
        }
        return;
    }

    // Export / Export PDF — monthly trade report PDF (Premium)
    if (
        text.toLowerCase() === 'export' ||
        text.toLowerCase() === 'export pdf' ||
        text.toLowerCase() === 'export trades' ||
        text.toLowerCase() === 'export report'
    ) {
        if (!planService.canUse(userId, 'canExport')) {
            await ctx.reply('🔒 Export PDF là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const stats = tradeService.getStats(userId);
        if (stats.closed === 0) {
            await ctx.reply('📄 Chưa có lệnh đã đóng nào để xuất báo cáo. Đóng vài lệnh trước nhé!');
            return;
        }
        await ctx.reply('📄 Đang tạo báo cáo PDF...');
        try {
            const profile = userService.getUser(userId);
            const traderName =
                toAscii(profile.fullName || profile.username || '') || `Trader ${userId}`;
            const pdf = await reportService.generateTradeReport({
                traderName,
                generatedAt: new Date(),
                stats,
                analytics: tradeService.getAnalytics(userId),
                closedTrades: [...tradeService.getClosedTrades(userId)].reverse(), // newest first
            });
            const fileName = `edgebook-trade-report-${new Date().toISOString().slice(0, 10)}.pdf`;
            await ctx.replyWithDocument(new InputFile(pdf, fileName), {
                caption: '📈 EdgeBook Trade Performance Report',
            });
        } catch (error) {
            console.error('PDF export error:', error);
            await ctx.reply('⚠️ Lỗi khi tạo PDF. Vui lòng thử lại sau.');
        }
        return;
    }

    // --- END TRADE JOURNAL COMMANDS ---

    // 1. Check if user wants to schedule something
    if (text.toLowerCase().includes('schedule') || text.toLowerCase().includes('meeting') || text.toLowerCase().includes('remind')) {
        const calendarData = await aiService.analyzeForCalendar(text);
        if (calendarData) {
            try {
                const eventLink = await googleService.createCalendarEvent(calendarData);
                await ctx.reply(`Created Event: ${calendarData.title}\nTime: ${calendarData.startTime}\nLink: ${eventLink}`);
            } catch (error) {
                await ctx.reply('Error creating calendar event. Please check configuration.');
            }
            return;
        }
    }

    // 2. Personalization Support
    const nameMatch = text.match(/call me (.+)/i) || text.match(/my name is (.+)/i);
    if (nameMatch) {
        const newName = nameMatch[1].trim();
        aiService.getUserService().updateUser(userId, { fullName: newName });
        aiService.refreshSession(userId);
        await ctx.reply(`Hello ${newName}! I have remembered your name.`);
        return;
    }

    const jobMatch = text.match(/my job is (.+)/i) || text.match(/i work as (.+)/i);
    if (jobMatch) {
        const newJob = jobMatch[1].trim();
        aiService.getUserService().updateUser(userId, { jobTitle: newJob });
        aiService.refreshSession(userId);
        await ctx.reply(`I have noted that your job is: ${newJob}`);
        return;
    }

    if (text.toLowerCase().startsWith('remember:')) {
        const note = text.substring(9).trim();
        aiService.getUserService().addNote(userId, note);
        aiService.refreshSession(userId);
        await ctx.reply('Note added to your profile.');
        return;
    }

    // 3. Save to Docs (Command OR Forward) — ENHANCED with Research OS
    // Check for "Save:" command OR if the message is Forwarded
    const isForward = isForwarded(ctx.message);
    const isSaveCommand = text.toLowerCase().startsWith('save:');

    if (isSaveCommand || isForward) {
        let content = text;
        if (isSaveCommand) {
            content = text.substring(5).trim(); // "Save:".length = 5
        } else {
            content = text;
        }

        // --- Rate limiting for free users ---
        const forwardCheck = planService.canForward(userId);
        if (!forwardCheck.allowed) {
            await ctx.reply(
                `⚠️ Bạn đã dùng hết ${forwardCheck.limit} forwards/ngày (Free plan).\n\n` +
                `Nâng cấp Pro để forward không giới hạn!\n` +
                `Gõ /plan để xem chi tiết.`
            );
            return;
        }

        const targetDocId = userService.getActiveDocId(userId) || config.googleDocId;

        // --- Save to Research Service (auto-tag) ---
        const forwardFrom = getForwardSource(ctx.message);

        const researchItem = researchService.addItem(userId, content, forwardFrom);
        planService.incrementForwardCount(userId);

        // --- Thesis conflict detection (Premium): alert if new research contradicts an active thesis ---
        let thesisAlert = '';
        if (planService.canUse(userId, 'canThesis') && researchItem.sentiment !== 0) {
            const conflicts: ThesisItem[] = [];
            const seen = new Set<string>();
            for (const ticker of researchItem.tickers) {
                for (const t of thesisService.findConflicts(userId, ticker, researchItem.sentiment)) {
                    if (!seen.has(t.id)) { seen.add(t.id); conflicts.push(t); }
                }
            }
            if (conflicts.length > 0) {
                const sEmoji = researchItem.sentiment < 0 ? '🔴' : '🟢';
                const sVal = `${researchItem.sentiment > 0 ? '+' : ''}${researchItem.sentiment.toFixed(2)}`;
                thesisAlert = '⚠️ Thesis mâu thuẫn!\n' +
                    conflicts.map((t) => {
                        const e = t.stance === 'bullish' ? '📈' : '📉';
                        return `${e} ${t.ticker} (${t.stance}): "${t.text}"`;
                    }).join('\n') +
                    `\n\nTin vừa lưu ${sEmoji} sentiment ${sVal}, ngược hướng thesis. Xem lại? Gõ Theses.`;
            }
        }

        // Build tag info for reply
        const tagInfo = researchItem.tickers.length > 0
            ? `\n🏷️ Tags: ${researchItem.tickers.join(', ')}`
            : '';
        const catInfo = researchItem.categories.filter(c => c !== 'general').length > 0
            ? `\n📂 ${researchItem.categories.filter(c => c !== 'general').join(', ')}`
            : '';
        const sentimentEmoji = researchItem.sentiment > 0.2 ? '🟢' : researchItem.sentiment < -0.2 ? '🔴' : '🟡';
        const sentimentInfo = researchItem.sentiment !== 0 ? `\n${sentimentEmoji} Sentiment: ${researchItem.sentiment > 0 ? '+' : ''}${researchItem.sentiment.toFixed(2)}` : '';

        // --- Also save to Google Docs (existing behavior) ---
        if (targetDocId) {
            try {
                await googleService.appendToDocs(targetDocId, `${content}`);
                const source = isForward ? 'forwarded message' : 'content';
                try {
                    await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❤' }]);
                    // Send tag info as a separate quiet reply if tags were found
                    if (tagInfo || catInfo) {
                        await ctx.reply(`📊 Research saved!${tagInfo}${catInfo}${sentimentInfo}`);
                    }
                } catch (e) {
                    // Fallback if reactions are disabled or not supported
                    await ctx.reply(`✅ Saved ${source} to Google Docs${tagInfo}${catInfo}${sentimentInfo}`);
                }
            } catch (error) {
                // Google Docs failed, but research is still saved locally
                await ctx.reply(`✅ Research saved locally${tagInfo}${catInfo}${sentimentInfo}\n⚠️ Google Docs sync failed.`);
            }
        } else {
            // No Google Doc configured — still save to research
            await ctx.reply(`✅ Research saved!${tagInfo}${catInfo}${sentimentInfo}\n💡 Tip: Add Doc [name] [ID] để sync với Google Docs.`);
        }

        // Show remaining quota for free users
        const remaining = planService.canForward(userId);
        if (remaining.limit !== -1 && remaining.remaining <= 3 && remaining.remaining > 0) {
            await ctx.reply(`⚡ Còn ${remaining.remaining}/${remaining.limit} forwards hôm nay.`);
        }

        // Surface a thesis-conflict alert (if any) as a separate, prominent message.
        if (thesisAlert) {
            await ctx.reply(thesisAlert);
        }

        return;
    }

    // 4. Default: Chat with AI
    const response = await aiService.chat(text, userId);
    await ctx.reply(response, { parse_mode: 'Markdown' });
});

// Photo Handler
bot.on('message:photo', async (ctx) => {
    const photo = ctx.message.photo.pop();
    const caption = ctx.message.caption || '';
    const userId = ctx.from?.id;

    if (!photo || !userId) return;

    // Check for "Save" keyword OR if it is a Forward
    const isForward = isForwarded(ctx.message);
    const hasSaveKeyword = /save/i.test(caption); // No longer checking "lưu" unless requested

    if (!hasSaveKeyword && !isForward) {
        return;
    }

    await ctx.replyWithChatAction('upload_photo');

    // Rate limiting
    const forwardCheck = planService.canForward(userId);
    if (!forwardCheck.allowed) {
        await ctx.reply(
            `⚠️ Bạn đã dùng hết ${forwardCheck.limit} forwards/ngày (Free plan).\n` +
            `Nâng cấp Pro để forward không giới hạn!`
        );
        return;
    }

    try {
        const file = await ctx.api.getFile(photo.file_id);
        if (file.file_path) {
            const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

            try {
                const targetDocId = userService.getActiveDocId(userId) || config.googleDocId;

                if (targetDocId) {
                    let cleanCaption = caption;
                    if (hasSaveKeyword) {
                        cleanCaption = caption.replace(/^save:?\s*/i, '').trim();
                    } else if (isForward && caption) {
                        cleanCaption = caption;
                    } else if (isForward) {
                        cleanCaption = ``;
                    }

                    await googleService.insertImageToDocs(targetDocId, fileUrl, cleanCaption);

                    // Also save caption to research if it has content
                    if (cleanCaption) {
                        const forwardFrom = getForwardSource(ctx.message);
                        researchService.addItem(userId, `[Image] ${cleanCaption}`, forwardFrom);
                    }
                    planService.incrementForwardCount(userId);

                    try {
                        await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❤' }]);
                    } catch (e) {
                        await ctx.reply(`✅ Saved image to Google Docs (${targetDocId.substring(0, 10)}...).`);
                    }
                } else {
                    await ctx.reply('⚠️ Google Doc ID not configured.');
                }
            } catch (docError) {
                console.error('Docs Insert Error:', docError);
                await ctx.reply('⚠️ Failed to save image to Docs.');
            }
        }
    } catch (error) {
        console.error('Photo handling error', error);
        await ctx.reply('Error handling photo.');
    }
});

// --- DAILY DIGEST CRON JOB ---
// Runs at 08:00 every day (Asia/Ho_Chi_Minh timezone)
cron.schedule('0 8 * * *', async () => {
    console.log('[Digest] Running daily digest cron...');

    // Get all users who have digest enabled (Pro/Premium)
    const eligibleUsers = planService.getDigestEligibleUsers();
    // Also include users who have research items (they might all be free during early access)
    const allResearchUsers = researchService.getAllUserIds();
    const usersToDigest = [...new Set([...eligibleUsers, ...allResearchUsers])];

    for (const userId of usersToDigest) {
        try {
            const digestData = researchService.getDigestData(userId, 24);
            if (digestData.totalItems === 0) continue; // Skip users with no new research

            const digest = await aiService.generateDigest(digestData);
            await bot.api.sendMessage(userId, `📬 Daily Research Digest\n\n${digest}`);
            console.log(`[Digest] Sent digest to user ${userId} (${digestData.totalItems} items)`);
        } catch (error) {
            console.error(`[Digest] Error sending digest to user ${userId}:`, error);
        }
    }

    // Also check for expired plans
    planService.checkExpiredPlans();

    console.log('[Digest] Daily digest cron completed.');
}, {
    timezone: 'Asia/Ho_Chi_Minh',
});

// --- WEEKLY REPORT CRON JOB ---
// Runs at 18:00 every Sunday (Asia/Ho_Chi_Minh timezone)
cron.schedule('0 18 * * 0', async () => {
    console.log('[Weekly] Running weekly report cron...');

    const eligibleUsers = planService.getDigestEligibleUsers();
    const allResearchUsers = researchService.getAllUserIds();
    const usersToReport = [...new Set([...eligibleUsers, ...allResearchUsers])];

    for (const userId of usersToReport) {
        try {
            // Only send to users who can use digest (Pro/Premium).
            if (!planService.canUse(userId, 'canDigest')) continue;
            const weeklyData = researchService.getWeeklyReportData(userId);
            if (weeklyData.totalItems === 0) continue; // Skip users with no research this week

            const report = await aiService.generateWeeklyReport(weeklyData);
            await bot.api.sendMessage(userId, `🗓️ Weekly Research Report\n\n${report}`);
            console.log(`[Weekly] Sent weekly report to user ${userId} (${weeklyData.totalItems} items)`);
        } catch (error) {
            console.error(`[Weekly] Error sending weekly report to user ${userId}:`, error);
        }
    }

    console.log('[Weekly] Weekly report cron completed.');
}, {
    timezone: 'Asia/Ho_Chi_Minh',
});

// --- /upgrade command ---
bot.command('upgrade', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const plan = planService.getPlan(userId);

    if (!config.lsApiKey) {
        await ctx.reply('⚠️ Tính năng thanh toán chưa được kích hoạt. Vui lòng liên hệ admin.');
        return;
    }

    if (plan.tier === 'premium') {
        await ctx.reply('💎 Bạn đang dùng Premium, plan cao nhất! Cảm ơn đã ủng hộ 🙏');
        return;
    }

    const keyboard = new InlineKeyboard()
        .text('⭐ Pro · $9.99/tháng', 'upgrade_pro')
        .row()
        .text('💎 Premium · $24.99/tháng', 'upgrade_premium');

    const currentTierText = plan.tier === 'pro'
        ? 'Bạn đang dùng ⭐ Pro. Upgrade lên 💎 Premium để mở khoá Sentiment & Export.'
        : 'Chọn plan muốn nâng cấp:';

    await ctx.reply(
        `💳 Nâng cấp EdgeBook\n\n${currentTierText}\n\n` +
        `⭐ Pro ($9.99/tháng):\n• Unlimited forwards\n• Search & Tag\n• Daily Digest\n• Ask AI\n\n` +
        `💎 Premium ($24.99/tháng):\n• Tất cả Pro features\n• Sentiment scoring\n• Export research\n• Unlimited Docs`,
        { reply_markup: keyboard }
    );
});

// Handle upgrade inline keyboard callbacks
bot.callbackQuery('upgrade_pro', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.reply('⏳ Đang tạo link thanh toán...');
    const url = await paymentService.createCheckoutLink(userId, 'pro');

    if (!url) {
        await ctx.reply('❌ Không thể tạo link thanh toán. Vui lòng thử lại sau hoặc liên hệ admin.');
        return;
    }

    await ctx.reply(
        `⭐ Link thanh toán Pro ($9.99/tháng):\n\n${url}\n\n` +
        `⏰ Link có hiệu lực trong 30 phút.\n` +
        `Sau khi thanh toán, plan sẽ tự động cập nhật! 🚀`
    );
});

bot.callbackQuery('upgrade_premium', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.reply('⏳ Đang tạo link thanh toán...');
    const url = await paymentService.createCheckoutLink(userId, 'premium');

    if (!url) {
        await ctx.reply('❌ Không thể tạo link thanh toán. Vui lòng thử lại sau hoặc liên hệ admin.');
        return;
    }

    await ctx.reply(
        `💎 Link thanh toán Premium ($24.99/tháng):\n\n${url}\n\n` +
        `⏰ Link có hiệu lực trong 30 phút.\n` +
        `Sau khi thanh toán, plan sẽ tự động cập nhật! 🚀`
    );
});

// Research-to-trade link callbacks (Premium)
bot.callbackQuery(/^linkres:([^:]+):([^:]+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    if (!planService.canUse(userId, 'canLinkResearch')) {
        await ctx.answerCallbackQuery({ text: '🔒 Tính năng Premium', show_alert: true });
        return;
    }
    const tradeId = ctx.match![1];
    const researchId = ctx.match![2];

    // Validate BOTH records exist before mutating, so a stale callback can't
    // persist a dangling research id (which would show a phantom 🔗 count).
    const research = researchService.getItemById(userId, researchId);
    if (!research || !tradeService.getTradeById(userId, tradeId)) {
        await ctx.answerCallbackQuery({ text: '⚠️ Không tìm thấy lệnh hoặc research', show_alert: true });
        return;
    }
    const trade = tradeService.linkResearch(userId, tradeId, researchId)!;
    await ctx.answerCallbackQuery({ text: '✅ Đã link!' });
    const count = trade.linkedResearch?.length ?? 0;
    await ctx.editMessageText(
        `🔗 Đã link ${trade.direction.toUpperCase()} ${trade.ticker} → "${researchLabel(research.content, 50)}"\n` +
        `Tổng research đã link: ${count}`
    );
});

bot.callbackQuery(/^linkres_skip:.+$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('👍 Đã bỏ qua link research.');
});

// Slash commands shown in Telegram's command menu (the list that pops up on "/").
const BOT_COMMANDS = [
    { command: 'start', description: '👋 Khởi động & giới thiệu EdgeBook' },
    { command: 'help', description: '📓 Hướng dẫn sử dụng & danh sách lệnh' },
    { command: 'plan', description: '💳 Xem gói hiện tại & giới hạn' },
    { command: 'upgrade', description: '⭐ Nâng cấp Pro / Premium' },
];

// Start webhook server (runs alongside bot polling)
startWebhookServer(paymentService, bot);

// Start the bot
bot.start({
    onStart: async (botInfo) => {
        console.log(`EdgeBook bot @${botInfo.username} started!`);
        console.log('EdgeBook features enabled: auto-tag, search, digest, star, stats, trade journal');
        console.log('Payment: /upgrade command enabled' + (config.lsApiKey ? '' : ' (⚠️ LS keys not set)'));
        try {
            await bot.api.setMyCommands(BOT_COMMANDS);
            console.log(`Registered ${BOT_COMMANDS.length} bot commands in the "/" menu.`);
        } catch (e) {
            console.error('Failed to register bot commands:', e);
        }
    },
});
