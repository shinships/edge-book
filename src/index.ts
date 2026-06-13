import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config';
import { AIService } from './services/ai.service';
import { GoogleService, GoogleApiError } from './services/google.service';
import { UserService } from './services/user.service';
import { TodoService } from './services/todo.service';
import { ResearchService } from './services/research.service';
import { PlanService } from './services/plan.service';
import { PaymentService } from './services/payment.service';
import { SepayService } from './services/sepay.service';
import { TradeService } from './services/trade.service';
import { ReportService } from './services/report.service';
import { ThesisService, ThesisItem } from './services/thesis.service';
import { MarketService } from './services/market.service';
import { AlertService } from './services/alert.service';
import { WatchlistService } from './services/watchlist.service';
import { DisciplineService } from './services/discipline.service';
import { GrowthService } from './services/growth.service';
import { ReferralService } from './services/referral.service';
import { TradeItem } from './services/trade.service';
import { startWebhookServer } from './webhook.server';
import cron from 'node-cron';

const bot = new Bot(config.telegramBotToken);
const aiService = new AIService();
const googleService = new GoogleService();
const todoService = new TodoService();
const userService = new UserService();
const researchService = new ResearchService();
const planService = new PlanService(config.adminUserIds);
const paymentService = new PaymentService(planService);
const sepayService = new SepayService(planService);
const tradeService = new TradeService();
const reportService = new ReportService();
const thesisService = new ThesisService();
const marketService = new MarketService();
const alertService = new AlertService();
const watchlistService = new WatchlistService();
const disciplineService = new DisciplineService();
const growthService = new GrowthService();
const referralService = new ReferralService();

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

// Parse a bare positive percent like "1", "1%", "0.5" (no sign, no "k").
// Used for the optional `risk`/`fee` values on Trade: open.
function parseBarePercent(raw?: string): number | undefined {
    if (!raw) return undefined;
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)%?$/);
    if (!m) return undefined;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
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

// Best-effort live-price block for digests. Returns '' on any failure so the
// digest always sends, with or without prices.
async function buildPriceBlock(tickers: string[]): Promise<string> {
    try {
        const top = tickers.slice(0, 5);
        if (top.length === 0) return '';
        const stats = await marketService.get24hStats(top);
        const lines = top
            .map((t) => {
                const s = stats.get(t);
                if (!s) return null;
                const e = s.changePercent >= 0 ? '🟢' : '🔴';
                return `${e} ${t}: ${formatPrice(s.price)} (${fmtPct(Math.round(s.changePercent * 10) / 10)})`;
            })
            .filter((l): l is string => l !== null);
        return lines.length > 0 ? `\n\n💹 Giá hiện tại:\n${lines.join('\n')}` : '';
    } catch (e) {
        console.error('[Digest] price enrichment skipped:', e);
        return '';
    }
}

// --- DISCIPLINE: 15s safety gate (in-memory, like AI sessions) ---

type OpenTradeParams = Parameters<TradeService['openTrade']>[1];

interface PendingTrade {
    params: OpenTradeParams;
    createdAt: number;
    checks: boolean[];
}

const pendingTrades = new Map<number, PendingTrade>();
const SAFETY_DELAY_MS = 15_000;
const PENDING_TTL_MS = 10 * 60_000;

const SAFETY_CHECKLIST = [
    'Đúng setup trong kế hoạch?',
    'Risk đúng kế hoạch, không tăng size gỡ lỗ?',
    'Không phải FOMO / revenge trade?',
];

function safetyKeyboard(pending: PendingTrade): InlineKeyboard {
    const kb = new InlineKeyboard();
    SAFETY_CHECKLIST.forEach((q, i) => {
        kb.text(`${pending.checks[i] ? '✅' : '⬜'} ${q}`, `dchk:${i}`).row();
    });
    const elapsed = Date.now() - pending.createdAt;
    const waitLeft = Math.max(0, Math.ceil((SAFETY_DELAY_MS - elapsed) / 1000));
    kb.text(waitLeft > 0 ? `🔓 Vào lệnh (chờ ${waitLeft}s)` : '🔓 Vào lệnh', 'dgo')
        .text('✖️ Huỷ', 'dcancel');
    return kb;
}

function emotionKeyboard(tradeId: string): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (let i = 1; i <= 5; i++) kb.text(`${i}`, `emo:${tradeId}:${i}`);
    kb.row();
    for (let i = 6; i <= 10; i++) kb.text(`${i}`, `emo:${tradeId}:${i}`);
    kb.row().text('Bỏ qua', `emoskip:${tradeId}`);
    return kb;
}

// Warning when emotion score or heart rate signals cortisol/adrenaline overload.
function emotionWarning(score?: number, heartRate?: number): string | null {
    const stressed = (score !== undefined && score >= 8) || (heartRate !== undefined && heartRate >= 110);
    if (!stressed) return null;
    return (
        '🚨 Cảnh báo tâm lý: ' +
        (heartRate !== undefined && heartRate >= 110 ? `nhịp tim ${heartRate} bpm` : `mức căng thẳng ${score}/10`) +
        ' cho thấy cơ thể đang bơm cortisol và adrenaline, bạn đang mất dần sự sáng suốt.\n' +
        '💡 Đứng dậy, rời màn hình 10 phút và hít thở sâu. Cân nhắc không vào thêm lệnh hôm nay.'
    );
}

// Build the open-trade confirmation message (shared by the direct path and the safety-gate path).
function buildOpenReply(trade: TradeItem): string {
    const dirEmoji = trade.direction === 'long' ? '🟢' : '🔴';
    const reversed =
        (trade.stopLoss !== undefined && trade.takeProfit !== undefined) &&
        (trade.direction === 'long'
            ? !(trade.takeProfit > trade.entryPrice && trade.stopLoss < trade.entryPrice)
            : !(trade.takeProfit < trade.entryPrice && trade.stopLoss > trade.entryPrice));
    return (
        `${dirEmoji} Đã mở lệnh ${trade.direction.toUpperCase()} ${trade.ticker}\n` +
        `Entry: ${formatPrice(trade.entryPrice)}` +
        (trade.stopLoss !== undefined ? `\nSL: ${formatPrice(trade.stopLoss)}` : '') +
        (trade.takeProfit !== undefined ? `\nTP: ${formatPrice(trade.takeProfit)}` : '') +
        (trade.positionSize !== undefined ? `\nSize: ${formatPrice(trade.positionSize)}` : '') +
        (trade.riskPercent !== undefined ? `\nRisk: ${trade.riskPercent}%/tài khoản` : '') +
        (trade.feePercent !== undefined ? `\nFee: ${trade.feePercent}%` : '') +
        (trade.setupTag ? `\nSetup: #${trade.setupTag}` : '') +
        (trade.emotionScore !== undefined ? `\nEmotion: ${trade.emotionScore}/10` : '') +
        (trade.heartRate !== undefined ? `\nNhịp tim: ${trade.heartRate} bpm` : '') +
        (reversed ? '\n⚠️ SL/TP ngược chiều với hướng lệnh, sẽ không tính RR.' : '')
    );
}

// Post-open follow-ups: stress warning + emotion prompt when not yet scored.
async function sendOpenFollowups(
    send: (text: string, opts?: { reply_markup: InlineKeyboard }) => Promise<unknown>,
    trade: TradeItem
): Promise<void> {
    const warn = emotionWarning(trade.emotionScore, trade.heartRate);
    if (warn) await send(warn);
    if (trade.emotionScore === undefined) {
        await send(
            '🧠 Trạng thái cảm xúc lúc vào lệnh? (1 = rất bình tĩnh, 10 = cực căng thẳng)',
            { reply_markup: emotionKeyboard(trade.id) }
        );
    }
}

// Format the remaining cooldown as "Xh Ym".
function formatCooldownLeft(until: Date): string {
    const mins = Math.max(1, Math.round((until.getTime() - Date.now()) / 60_000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Build a short label for a closed trade in audit prompts.
function auditLabel(t: TradeItem): string {
    const pnl = t.pnlPercent ?? 0;
    const e = pnl > 0 ? '✅' : '❌';
    return `${e} ${t.direction.toUpperCase()} ${t.ticker} ${fmtPct(pnl)}` +
        (t.setupTag ? ` · #${t.setupTag}` : '');
}

function auditKeyboard(tradeId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text('✅ Đúng quy trình', `audit:${tradeId}:1`)
        .text('❌ Vi phạm', `audit:${tradeId}:0`);
}

// Build a short, single-line preview label for a research item (for inline buttons).
function researchLabel(content: string, max = 40): string {
    const oneLine = content.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

// Format an average hold duration (in hours) for display: "45m", "3.5h", "2d 4h".
function formatHold(hours: number): string {
    const totalMinutes = Math.round(hours * 60);
    if (totalMinutes < 60) return `${totalMinutes}m`;

    const totalHours = totalMinutes / 60;
    if (totalHours < 24) {
        const h = Math.round(totalHours * 10) / 10;
        if (h < 24) return `${h}h`;
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
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .replace(/[^\x20-\x7e]/g, '')
        .trim();
}

// Telegram Bot API 7.0 (Dec 2023) removed forward_date/forward_from/forward_from_chat/
// forward_sender_name in favour of a single `forward_origin` object.
function isForwarded(message: any): boolean {
    return message?.forward_origin !== undefined;
}

// Build a clickable Google Docs URL from a document ID.
function docUrl(docId: string): string {
    return `https://docs.google.com/document/d/${docId}/edit`;
}

function stripWrappers(s: string): string {
    return s.replace(/^[\[\(<"'`]+/, '').replace(/[\]\)>"'`]+$/, '').trim();
}

async function docSyncErrorReason(error: any, docId: string): Promise<string> {
    if (error instanceof GoogleApiError && error.status === 403) {
        const sa = googleService.getServiceAccountEmail();
        const shareWith = sa ? `\n📧 Share doc cho email này (quyền Editor):\n${sa}` : '';
        return `\n⚠️ Bot chưa có quyền edit doc đang chọn.${shareWith}\n🔗 ${docUrl(docId)}`;
    }
    // Inline image insert stores a copy in the doc OWNER's Drive. A 400/badRequest here
    // almost always means the owner's Drive is full (text appends still work because they
    // cost ~no storage). We can't read the owner's quota via the service account, so we
    // surface the owner email and let the user free space / switch to a non-full account.
    if (error instanceof GoogleApiError && error.status === 400) {
        const owner = await googleService.getDocOwnerEmail(docId);
        const who = owner ? ` (${owner})` : '';
        return `\n⚠️ Không chèn được ảnh vào doc.` +
            `\nNguyên nhân thường gặp: tài khoản Google sở hữu doc${who} đã hết dung lượng Drive` +
            ` (ảnh inline tốn dung lượng của chủ doc, còn text thì không).` +
            `\n👉 Giải phóng dung lượng Drive của tài khoản đó, hoặc dùng doc thuộc tài khoản còn trống.` +
            `\n🔗 ${docUrl(docId)}`;
    }
    return `\n⚠️ Google Docs sync failed.`;
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

// Deep-link acquisition source: t.me/<bot>?start=src_<channel> or ?start=ref_<userId>.
// Returns a normalized source label, or undefined for plain /start (organic).
function parseAcquisitionSource(payload?: string): string | undefined {
    if (!payload) return undefined;
    if (payload.startsWith('src_')) {
        const source = payload.slice(4).toLowerCase();
        return source || undefined;
    }
    if (payload.startsWith('ref_')) return 'referral';
    return undefined;
}

// Reward both sides of a referral (+7 days Pro) once the referee reaches
// activation (their first-ever research item). Milestones at 3/10 successful
// referrals grant the referrer extra bonus days. Best-effort: a reward hiccup
// never blocks the Save flow.
async function maybeRewardReferral(userId: number): Promise<void> {
    try {
        if (!(await referralService.hasPending(userId))) return;

        const items = await researchService.getItems(userId);
        if (items.length !== 1) return; // only the very first save counts

        const result = await referralService.reward(userId);
        if (!result) return;

        await planService.grantBonusDays(userId, 7);
        await planService.grantBonusDays(result.referrerId, 7);

        await bot.api.sendMessage(userId,
            '🎁 Bạn vừa lưu research đầu tiên! +7 ngày Pro đã được cộng vào tài khoản. Cảm ơn đã tham gia EdgeBook.'
        ).catch(() => {});
        await bot.api.sendMessage(result.referrerId,
            `🎉 Người bạn mời đã hoạt động! Bạn nhận +7 ngày Pro. Đã mời thành công: ${result.referrerRewardedCount} người.`
        ).catch(() => {});

        if (result.referrerRewardedCount === 3) {
            await planService.grantBonusDays(result.referrerId, 30, 'pro');
            await bot.api.sendMessage(result.referrerId,
                '🏆 Mốc 3 lượt mời thành công! Bạn nhận thêm +30 ngày Pro.'
            ).catch(() => {});
        } else if (result.referrerRewardedCount === 10) {
            await planService.grantBonusDays(result.referrerId, 30, 'premium');
            await bot.api.sendMessage(result.referrerId,
                '👑 Mốc 10 lượt mời thành công! Bạn được nâng cấp +30 ngày Premium.'
            ).catch(() => {});
        }
    } catch (e) {
        console.error('Referral reward error:', e);
    }
}

// Basic Command Handlers
bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) {
        const payload = ctx.match;
        const source = parseAcquisitionSource(payload);
        const { isNew } = await userService.createIfNew(userId, source);

        if (isNew && payload?.startsWith('ref_')) {
            const referrerId = Number(payload.slice(4));
            if (Number.isInteger(referrerId) && referrerId !== userId) {
                await referralService.record(referrerId, userId);
            }
        }
    }
    return ctx.reply(
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
    );
});

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
        '• Thêm tuỳ chọn: size 500 risk 1% fee 0.1% setup breakout emo 7 hr 95\n' +
        '• Close: BTC 112k · Close: BTC +3.2% · Close: BTC 105k sl\n' +
        '• Trades · Trade Stats\n' +
        '• Trade Analytics · Equity · Export PDF (Premium)\n' +
        '\n' +
        '🧠 Discipline & Psychology (Pro)\n' +
        '• Trade: qua chốt an toàn 15s + checklist (mặc định bật)\n' +
        '• Discipline → trạng thái · Discipline On/Off\n' +
        '• Limit: 3 → giới hạn lệnh thua/ngày, chạm là khoá Trade:\n' +
        '• Review → đối soát quy trình các lệnh đóng hôm nay\n' +
        '• Thua lệnh → bot hỏi có tuân thủ kế hoạch, nhắc giảm 50% size\n' +
        '\n' +
        '💹 Market & Alerts\n' +
        '• Watch: BTC · Unwatch: BTC · Watchlist → giá live + 24h\n' +
        '• Alert: BTC > 70k · Alert: ETH < 2400 (Pro)\n' +
        '• Alerts → xem & xoá alerts đang chạy\n' +
        '\n' +
        '💳 Tài khoản\n' +
        '• /plan · /upgrade\n' +
        '• /invite → mời bạn, cả hai nhận +7 ngày Pro khi bạn ấy lưu research đầu tiên'
    );
});

// General Chat Handler
bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from?.id;

    await ctx.replyWithChatAction('typing');

    if (!userId) {
        await ctx.reply('Error: Unknown User ID.');
        return;
    }

    // --- DOCS MANAGEMENT COMMANDS ---
    const addDocMatch = text.match(/^add doc\s+(\S+)\s+(\S+)/i);
    if (addDocMatch) {
        const alias = stripWrappers(addDocMatch[1]);
        const docId = stripWrappers(addDocMatch[2]);
        if (!alias || !docId) {
            await ctx.reply('⚠️ Cú pháp: Add Doc tên ID (không cần ngoặc vuông).');
            return;
        }
        await userService.setDocAlias(userId, alias, docId);
        await ctx.reply(`✅ Added Doc "${alias}". Set as default if none existed.`);
        return;
    }

    const setDocMatch = text.match(/^use doc\s+(\S+)/i);
    if (setDocMatch) {
        const alias = stripWrappers(setDocMatch[1]);
        if (await userService.setActiveDoc(userId, alias)) {
            await ctx.reply(`✅ Switched to Doc: ${alias}`);
        } else {
            await ctx.reply(`⚠️ Doc "${alias}" not found. Use Add Doc first.`);
        }
        return;
    }

    if (text.toLowerCase() === 'current doc') {
        const activeId = await userService.getActiveDocId(userId);
        if (activeId) {
            const alias = await userService.getActiveDocAlias(userId);
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

    // --- TO-DO LIST COMMANDS ---
    if (text.toLowerCase().startsWith('add task:')) {
        const task = text.substring(9).trim();
        if (task) {
            await todoService.addTodo(userId, task);
            await ctx.reply(`Added task: "${task}"`);
            return;
        }
    }

    if (text.toLowerCase() === 'list tasks' || text.toLowerCase() === 'todo list') {
        const items = (await todoService.getTodos(userId)).filter((i) => !i.completed);
        if (items.length === 0) {
            await ctx.reply('You have no pending tasks.');
        } else {
            const list = items.map((i, idx) => `${idx + 1}. ${i.task}`).join('\n');
            await ctx.reply(`Your To-Do List:\n${list}`);
        }
        return;
    }

    if (text.toLowerCase().startsWith('complete task:')) {
        const keyword = text.substring(14).trim();
        if (keyword) {
            const completedItem = await todoService.completeTodo(userId, keyword);
            if (completedItem) {
                await ctx.reply(`Marked as done: "${completedItem.task}"`);
            } else {
                await ctx.reply('Task not found.');
            }
            return;
        }
    }

    // --- RESEARCH OS COMMANDS ---

    if (text.toLowerCase().startsWith('search:')) {
        const keyword = text.substring(7).trim();
        if (!keyword) {
            await ctx.reply('⚠️ Vui lòng nhập keyword. Ví dụ: Search: BTC');
            return;
        }

        if (!await planService.canUse(userId, 'canSearch')) {
            await ctx.reply('🔒 Search là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        const results = await researchService.searchByKeyword(userId, keyword);
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

    if (text.toLowerCase().startsWith('tag:')) {
        const ticker = text.substring(4).trim().toUpperCase();
        if (!ticker) {
            await ctx.reply('⚠️ Vui lòng nhập ticker. Ví dụ: Tag: BTC');
            return;
        }

        if (!await planService.canUse(userId, 'canSearch')) {
            await ctx.reply('🔒 Search/Tag là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        const results = await researchService.searchByTicker(userId, ticker);
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

    if (text.toLowerCase() === 'digest off') {
        if (!await planService.canUse(userId, 'canDigest')) {
            await ctx.reply('🔒 Daily Digest là tính năng Pro. Gõ /plan để xem chi tiết.');
            return;
        }
        await planService.setDigestEnabled(userId, false);
        await ctx.reply('🔕 Đã tắt Daily Digest.\nBot sẽ không tự gửi digest lúc 8:00 sáng nữa.\n\nGõ Digest On để bật lại.');
        return;
    }

    if (text.toLowerCase() === 'digest on') {
        if (!await planService.canUse(userId, 'canDigest')) {
            await ctx.reply('🔒 Daily Digest là tính năng Pro. Gõ /plan để xem chi tiết.');
            return;
        }
        await planService.setDigestEnabled(userId, true);
        await ctx.reply('🔔 Đã bật Daily Digest.\nBot sẽ tự gửi digest lúc 8:00 sáng mỗi ngày.');
        return;
    }

    if (text.toLowerCase() === 'digest' || text.toLowerCase() === 'daily digest') {
        if (!await planService.canUse(userId, 'canDigest')) {
            await ctx.reply('🔒 Daily Digest là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const digestData = await researchService.getDigestData(userId, 24);
        const digest = await aiService.generateDigest(digestData);
        const priceBlock = await buildPriceBlock(digestData.topTickers.map((t) => t.ticker));
        await ctx.reply(digest + priceBlock);
        return;
    }

    if (
        text.toLowerCase() === 'weekly report' ||
        text.toLowerCase() === 'weekly' ||
        text.toLowerCase() === 'weekly digest'
    ) {
        if (!await planService.canUse(userId, 'canDigest')) {
            await ctx.reply('🔒 Weekly Report là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const weeklyData = await researchService.getWeeklyReportData(userId);
        const report = await aiService.generateWeeklyReport(weeklyData);
        await ctx.reply(report);
        return;
    }

    if (text.toLowerCase() === 'stats' || text.toLowerCase() === 'research stats') {
        const stats = await researchService.getStats(userId);
        if (stats.totalItems === 0) {
            await ctx.reply('📊 Chưa có research nào. Forward messages vào bot để bắt đầu!');
            return;
        }

        const topTickers = stats.topTickers.slice(0, 5).map((t) => `  ${t.ticker}: ${t.count}`).join('\n');
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

    if (text.toLowerCase() === 'starred' || text.toLowerCase() === 'bookmarks') {
        const starred = await researchService.getStarredItems(userId);
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

    if (text.toLowerCase() === 'star' || text.toLowerCase() === '⭐') {
        const starred = await researchService.starLatest(userId);
        if (starred) {
            await ctx.reply(`⭐ Đã bookmark: "${starred.content.substring(0, 80)}..."`);
        } else {
            await ctx.reply('⚠️ Không có research nào để bookmark.');
        }
        return;
    }

    if (text.toLowerCase().startsWith('ask:')) {
        const question = text.substring(4).trim();
        if (!question) {
            await ctx.reply('⚠️ Vui lòng nhập câu hỏi. Ví dụ: Ask: BTC tuần này có gì đáng chú ý?');
            return;
        }

        if (!await planService.canUse(userId, 'canSearch')) {
            await ctx.reply('🔒 Research Q&A là tính năng Pro. Nâng cấp để sử dụng!\n\nGõ /plan để xem chi tiết.');
            return;
        }

        await ctx.replyWithChatAction('typing');
        const items = await researchService.getItems(userId);
        const answer = await aiService.askAboutResearch(question, items);
        await ctx.reply(`🤖 Research AI:\n\n${answer}`);
        return;
    }

    if (text.toLowerCase() === '/plan' || text.toLowerCase() === 'my plan') {
        const info = await planService.getPlanInfo(userId);
        await ctx.reply(info);
        return;
    }

    // "Close Thesis: <index|ticker>" — close an active thesis (Premium)
    if (text.toLowerCase().startsWith('close thesis:')) {
        if (!await planService.canUse(userId, 'canThesis')) {
            await ctx.reply('🔒 Thesis Tracker là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const selector = text.slice(text.indexOf(':') + 1).trim();
        if (!selector) {
            await ctx.reply('⚠️ Cú pháp: Close Thesis: <số thứ tự hoặc ticker>. Gõ Theses để xem danh sách.');
            return;
        }
        const closed = await thesisService.closeThesis(userId, selector);
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
        if (!await planService.canUse(userId, 'canThesis')) {
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
        const thesis = await thesisService.addThesis(userId, rawTicker, stance, m[3]);
        const e = stance === 'bullish' ? '📈' : '📉';
        await ctx.reply(
            `${e} Đã ghi thesis ${thesis.ticker} (${stance}):\n"${thesis.text}"\n\n` +
            `🔔 Mình sẽ nhắc khi có research mâu thuẫn với luận điểm này.`
        );
        return;
    }

    // "Theses" / "My Theses" — list active theses (Premium)
    if (text.toLowerCase() === 'theses' || text.toLowerCase() === 'my theses') {
        if (!await planService.canUse(userId, 'canThesis')) {
            await ctx.reply('🔒 Thesis Tracker là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const active = await thesisService.getActiveTheses(userId);
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

    // --- TRADE JOURNAL COMMANDS (Pro) ---

    // Trade: Long BTC entry 108k SL 105k TP 115k
    if (text.toLowerCase().startsWith('trade:')) {
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const tradeUsage = '⚠️ Sai cú pháp. Ví dụ: Trade: Long BTC entry 108k SL 105k TP 115k';
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
        // \b before each keyword so "setup" (contains "tp") is not swallowed by the tp matcher.
        const entry = parsePrice(rest.match(/\bentry\s*(\S+)/i)?.[1]);
        const sl = parsePrice(rest.match(/\bsl\s*(\S+)/i)?.[1]);
        const tp = parsePrice(rest.match(/\btp\s*(\S+)/i)?.[1]);
        if (entry === undefined) {
            await ctx.reply('⚠️ Thiếu hoặc sai giá entry. ' + tradeUsage);
            return;
        }
        // Optional risk-based fields. If a keyword is present but its value is
        // malformed, warn and abort rather than silently dropping it.
        const sizeRaw = rest.match(/\bsize\s+(\S+)/i)?.[1];
        const riskRaw = rest.match(/\brisk\s+(\S+)/i)?.[1];
        const feeRaw = rest.match(/\bfee\s+(\S+)/i)?.[1];
        const setup = rest.match(/\bsetup\s+(\S+)/i)?.[1]?.toLowerCase();

        const size = sizeRaw !== undefined ? parsePrice(sizeRaw) : undefined;
        if (sizeRaw !== undefined && size === undefined) {
            await ctx.reply('⚠️ Giá trị size không hợp lệ. Ví dụ: size 500 hoặc size 1.5k');
            return;
        }
        const risk = riskRaw !== undefined ? parseBarePercent(riskRaw) : undefined;
        if (riskRaw !== undefined && (risk === undefined || risk > 100)) {
            await ctx.reply('⚠️ Giá trị risk không hợp lệ (0-100). Ví dụ: risk 1%');
            return;
        }
        const fee = feeRaw !== undefined ? parseBarePercent(feeRaw) : undefined;
        if (feeRaw !== undefined && (fee === undefined || fee >= 100)) {
            await ctx.reply('⚠️ Giá trị fee không hợp lệ. Ví dụ: fee 0.1%');
            return;
        }

        // Optional psychology fields: emo 1-10 (emotion score), hr <bpm> (heart rate).
        const emoRaw = rest.match(/\bemo\s+(\S+)/i)?.[1];
        const hrRaw = rest.match(/\bhr\s+(\S+)/i)?.[1];
        const emo = emoRaw !== undefined && /^\d{1,2}$/.test(emoRaw) ? parseInt(emoRaw, 10) : undefined;
        if (emoRaw !== undefined && (emo === undefined || emo < 1 || emo > 10)) {
            await ctx.reply('⚠️ Giá trị emo không hợp lệ (1-10). Ví dụ: emo 7');
            return;
        }
        const hr = hrRaw !== undefined && /^\d{2,3}$/.test(hrRaw) ? parseInt(hrRaw, 10) : undefined;
        if (hrRaw !== undefined && (hr === undefined || hr < 30 || hr > 250)) {
            await ctx.reply('⚠️ Nhịp tim không hợp lệ (30-250 bpm). Ví dụ: hr 95');
            return;
        }

        const params: OpenTradeParams = {
            ticker,
            direction,
            entryPrice: entry,
            stopLoss: sl,
            takeProfit: tp,
            positionSize: size,
            riskPercent: risk,
            feePercent: fee,
            setupTag: setup,
            emotionScore: emo,
            heartRate: hr,
        };

        // Discipline gate (default ON): cooldown lock + 15s safety switch with checklist.
        const dstate = await disciplineService.getState(userId);
        if (dstate.enabled) {
            const cooldownUntil = dstate.cooldownUntil ? new Date(dstate.cooldownUntil) : null;
            if (cooldownUntil && cooldownUntil.getTime() > Date.now()) {
                await ctx.reply(
                    `🔒 Đã chạm giới hạn ${dstate.dailyLossLimit} lệnh thua hôm nay. ` +
                    `Trade: mở lại sau ${formatCooldownLeft(cooldownUntil)}.\n` +
                    `Rời màn hình đi, thị trường mai vẫn còn. (Gõ Discipline Off nếu muốn tắt chế độ kỷ luật)`
                );
                return;
            }
            const pending: PendingTrade = { params, createdAt: Date.now(), checks: SAFETY_CHECKLIST.map(() => false) };
            pendingTrades.set(userId, pending);
            await ctx.reply(
                `🛡 Chốt an toàn 15 giây\n` +
                `${direction === 'long' ? '🟢' : '🔴'} ${direction.toUpperCase()} ${ticker} @ ${formatPrice(entry)}\n\n` +
                `Hít thở. Tick đủ checklist và chờ 15 giây để mở chốt:`,
                { reply_markup: safetyKeyboard(pending) }
            );
            return;
        }

        const trade = await tradeService.openTrade(userId, params);
        if (!trade) {
            await ctx.reply('⚠️ Không thể mở lệnh: giá không hợp lệ.');
            return;
        }
        await ctx.reply(buildOpenReply(trade));
        await sendOpenFollowups((t, o) => ctx.reply(t, o), trade);
        return;
    }

    // Close: BTC 112k  |  Close: BTC +3.2%
    if (text.toLowerCase().startsWith('close:')) {
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const closeUsage = '⚠️ Sai cú pháp. Ví dụ: Close: BTC 112k  hoặc  Close: BTC +3.2%';
        const m = text.slice(text.indexOf(':') + 1).trim().match(/^(\S+)\s+(\S+)(?:\s+(tp|sl|manual))?$/i);
        if (!m) {
            await ctx.reply(closeUsage);
            return;
        }
        const explicitReason = m[3]?.toLowerCase() as 'tp' | 'sl' | 'manual' | undefined;
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
        const closed = await tradeService.closeTrade(userId, ticker, exit, explicitReason);
        if (!closed) {
            await ctx.reply(`⚠️ Không tìm thấy lệnh open nào cho ${ticker}.`);
            return;
        }
        const pnl = closed.pnlPercent ?? 0;
        const emoji = pnl > 0 ? '✅' : '❌';
        const r = tradeService.actualR(closed);
        const fee = closed.feePercent;
        const reasonLine = closed.closeReason === 'tp'
            ? '\nLý do: chạm TP 🎯'
            : closed.closeReason === 'sl' ? '\nLý do: chạm SL 🛑' : '\nLý do: đóng tay';
        await ctx.reply(
            `${emoji} Đã đóng ${closed.direction.toUpperCase()} ${closed.ticker}\n` +
            `Entry: ${formatPrice(closed.entryPrice)} → Exit: ${formatPrice(closed.exitPrice!)}\n` +
            `PnL: ${fmtPct(pnl)}` +
            (fee !== undefined ? ` (net ${fmtPct(Math.round((pnl - fee) * 100) / 100)} sau fee)` : '') +
            (r !== null ? `\nR: ${r > 0 ? '+' : ''}${r}R` : '') +
            reasonLine
        );

        // Discipline follow-ups: streak tracking + daily loss limit + process audit on losses.
        const dstate = await disciplineService.getState(userId);
        if (dstate.enabled) {
            if (pnl < 0) {
                const loss = await disciplineService.recordLoss(userId);
                let msg = `📉 Lệnh thua thứ ${loss.lossStreak} liên tiếp` +
                    ` (${loss.lossesToday}/${loss.dailyLossLimit} hôm nay).\n` +
                    `Kỷ luật: giảm 50% rủi ro ở lệnh tiếp theo`;
                if (closed.riskPercent !== undefined) {
                    msg += ` (tối đa ${Math.round((closed.riskPercent / 2) * 100) / 100}%)`;
                } else if (closed.positionSize !== undefined) {
                    msg += ` (size tối đa ${formatPrice(closed.positionSize / 2)})`;
                }
                msg += '.';
                if (loss.limitHit) {
                    msg += `\n\n🛑 Đủ ${loss.dailyLossLimit} lệnh thua hôm nay. Trade: đã khoá tới hết ngày.\n` +
                        `Rời màn hình đi, thị trường mai vẫn còn.`;
                }
                await ctx.reply(msg);
                await ctx.reply(
                    (closed.closeReason === 'sl' ? 'Bạn đã để SL làm đúng việc của nó. ' : '') +
                    'Lệnh này bạn có tuân thủ đúng kế hoạch và mức cắt lỗ đã vạch ra không?',
                    { reply_markup: auditKeyboard(closed.id) }
                );
            } else if (pnl > 0) {
                await disciplineService.recordWin(userId);
            }
        }

        // Research-to-trade link (Premium): offer to link recent research on this ticker.
        if (await planService.canUse(userId, 'canLinkResearch')) {
            const alreadyLinked = new Set(closed.linkedResearch ?? []);
            let candidates = (await researchService.searchByTicker(userId, closed.ticker))
                .filter((r) => !alreadyLinked.has(r.id));
            if (candidates.length === 0) {
                candidates = (await researchService.getRecentItems(userId, 24 * 7))
                    .filter((r) => !alreadyLinked.has(r.id));
            }
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
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const [open, closedAll] = await Promise.all([
            tradeService.getOpenTrades(userId),
            tradeService.getClosedTrades(userId),
        ]);
        const closed = closedAll.slice(-5).reverse();
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
                const r = tradeService.actualR(t);
                msg += `${e} ${t.direction.toUpperCase()} ${t.ticker}: ${fmtPct(pnl)}` +
                    (r !== null ? ` · ${r > 0 ? '+' : ''}${r}R` : '') +
                    (t.setupTag ? ` · #${t.setupTag}` : '') + linkTag(t) + '\n';
            });
        }
        await ctx.reply(msg);
        return;
    }

    // --- DISCIPLINE & PSYCHOLOGY COMMANDS (Pro) ---

    // Discipline / Discipline On / Discipline Off
    const disciplineMatch = text.match(/^discipline(?:\s+(on|off))?$/i);
    if (disciplineMatch) {
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Discipline mode đi cùng Trade Journal (Pro). Gõ /upgrade để nâng cấp!');
            return;
        }
        const toggle = disciplineMatch[1]?.toLowerCase();
        if (toggle === 'on' || toggle === 'off') {
            await disciplineService.setEnabled(userId, toggle === 'on');
            await ctx.reply(toggle === 'on'
                ? '🛡 Discipline mode BẬT. Mỗi lệnh Trade: sẽ qua chốt an toàn 15s + checklist.'
                : '⚠️ Discipline mode TẮT. Trade: vào lệnh ngay, không qua chốt an toàn. Gõ Discipline On để bật lại.');
            return;
        }
        const s = await disciplineService.getState(userId);
        const cooldown = s.cooldownUntil ? new Date(s.cooldownUntil) : null;
        const inCd = cooldown !== null && cooldown.getTime() > Date.now();
        await ctx.reply(
            '🛡 Discipline mode\n\n' +
            `Trạng thái: ${s.enabled ? 'BẬT ✅' : 'TẮT ⚠️'}\n` +
            `Chuỗi thua hiện tại: ${s.lossStreak}\n` +
            `Thua hôm nay: ${s.lossesToday}/${s.dailyLossLimit}\n` +
            (inCd ? `🔒 Đang khoá Trade: thêm ${formatCooldownLeft(cooldown!)}\n` : '') +
            '\nLệnh: Discipline On · Discipline Off · Limit: 3 · Review'
        );
        return;
    }

    // Limit: 3 — set the daily losing-trade limit
    const limitMatch = text.match(/^limit:\s*(\d{1,2})\s*$/i);
    if (limitMatch) {
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Discipline mode đi cùng Trade Journal (Pro). Gõ /upgrade để nâng cấp!');
            return;
        }
        const limit = parseInt(limitMatch[1], 10);
        if (limit < 1 || limit > 10) {
            await ctx.reply('⚠️ Giới hạn hợp lệ: 1-10 lệnh thua/ngày. Ví dụ: Limit: 3');
            return;
        }
        await disciplineService.setDailyLossLimit(userId, limit);
        await ctx.reply(`✅ Đã đặt giới hạn ${limit} lệnh thua/ngày. Chạm giới hạn là Trade: khoá tới hết ngày.`);
        return;
    }

    // Review / Audit — process-audit today's closed trades on demand
    if (text.toLowerCase() === 'review' || text.toLowerCase() === 'audit') {
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const unaudited = (await tradeService.getUnauditedClosedToday(userId)).slice(0, 10);
        if (unaudited.length === 0) {
            await ctx.reply('🧭 Không có lệnh nào cần đối soát hôm nay. Mọi lệnh đóng hôm nay đã được review.');
            return;
        }
        await ctx.reply(`🧭 Đối soát quy trình: ${unaudited.length} lệnh đóng hôm nay chưa review.`);
        for (const t of unaudited) {
            await ctx.reply(`${auditLabel(t)}\nLệnh này có đúng quy trình không?`, { reply_markup: auditKeyboard(t.id) });
        }
        return;
    }

    // Trade Stats
    if (text.toLowerCase() === 'trade stats') {
        if (!await planService.canUse(userId, 'canTrade')) {
            await ctx.reply('🔒 Trade Journal là tính năng Pro. Gõ /plan để nâng cấp!');
            return;
        }
        const s = await tradeService.getStats(userId);
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
        if (s.rTradeCount > 0) {
            msg += `\nTổng R: ${s.totalR > 0 ? '+' : ''}${s.totalR}R (${s.rTradeCount} lệnh có SL)` +
                `\nExpectancy: ${s.avgR}R/lệnh`;
        }
        if (s.best) msg += `\nBest: ${s.best.ticker} ${fmtPct(s.best.pnlPercent ?? 0)}`;
        if (s.worst) msg += `\nWorst: ${s.worst.ticker} ${fmtPct(s.worst.pnlPercent ?? 0)}`;
        if (s.auditedCount > 0) {
            msg += `\n\n🧭 Kỷ luật (${s.auditedCount} lệnh đã đối soát)\n` +
                `Đúng quy trình: ${s.disciplineRate}%\n` +
                `PnL kỷ luật: ${fmtPct(s.disciplinedPnl)}` +
                (s.luckyPnl > 0 ? ` (đã loại ${fmtPct(s.luckyPnl)} thắng ăn may)` : '');
        }
        await ctx.reply(msg);
        return;
    }

    // Trade Analytics / Performance (Premium)
    if (
        text.toLowerCase() === 'trade analytics' ||
        text.toLowerCase() === 'analytics' ||
        text.toLowerCase() === 'performance'
    ) {
        if (!await planService.canUse(userId, 'canAnalytics')) {
            await ctx.reply('🔒 Performance Analytics là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const a = await tradeService.getAnalytics(userId);
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

        if (a.byEmotion && a.byEmotion.length > 0) {
            msg += '\n🧠 Theo cảm xúc lúc vào lệnh:\n';
            a.byEmotion.forEach((b) => {
                const label = b.label === 'calm' ? '😌 Bình tĩnh (emo ≤5)' : '😰 Căng thẳng (emo ≥7)';
                msg += `${label}: ${b.trades} lệnh · win ${b.winRate}% · avg ${fmtPct(b.avgPnl)}\n`;
            });
        }

        await ctx.reply(msg);

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
        if (!await planService.canUse(userId, 'canExport')) {
            await ctx.reply('🔒 Export PDF là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const stats = await tradeService.getStats(userId);
        if (stats.closed === 0) {
            await ctx.reply('📄 Chưa có lệnh đã đóng nào để xuất báo cáo. Đóng vài lệnh trước nhé!');
            return;
        }
        await ctx.reply('📄 Đang tạo báo cáo PDF...');
        try {
            const [profile, analytics, closedTrades] = await Promise.all([
                userService.getUser(userId),
                tradeService.getAnalytics(userId),
                tradeService.getClosedTrades(userId),
            ]);
            const traderName =
                toAscii(profile.fullName || profile.username || '') || `Trader ${userId}`;
            const pdf = await reportService.generateTradeReport({
                traderName,
                generatedAt: new Date(),
                stats,
                analytics,
                closedTrades: [...closedTrades].reverse().map((t) => ({
                    ...t,
                    rMultiple: tradeService.actualR(t),
                })),
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

    // Equity / Equity Curve — cumulative R curve (Premium)
    if (text.toLowerCase() === 'equity' || text.toLowerCase() === 'equity curve') {
        if (!await planService.canUse(userId, 'canAnalytics')) {
            await ctx.reply('🔒 Equity Curve là tính năng Premium. Gõ /upgrade để nâng cấp!');
            return;
        }
        const curve = await tradeService.getEquityCurve(userId);
        if (curve.points.length === 0) {
            await ctx.reply(
                '📈 Chưa có lệnh đóng nào có SL để tính R.\n' +
                'Mở lệnh kèm SL (Trade: Long BTC entry 108k SL 105k ...) rồi đóng để build equity curve.' +
                (curve.skipped > 0 ? `\n(${curve.skipped} lệnh không có SL, bị bỏ qua)` : '')
            );
            return;
        }
        const BLOCKS = '▁▂▃▄▅▆▇█';
        const pts = curve.points.slice(-30);
        const cums = pts.map((p) => p.cumR);
        const lo = Math.min(...cums);
        const hi = Math.max(...cums);
        const range = hi - lo;
        const spark = cums.map((v) => {
            const idx = range === 0 ? 4 : Math.round(((v - lo) / range) * 7);
            return BLOCKS[Math.max(0, Math.min(7, idx))];
        }).join('');
        const last = pts[pts.length - 1];
        await ctx.reply(
            '📈 Equity Curve (R tích lũy)\n\n' +
            `${spark}\n\n` +
            `Tổng R: ${curve.totalR > 0 ? '+' : ''}${curve.totalR}R (${curve.points.length} lệnh có SL)\n` +
            `Đỉnh: ${curve.maxCumR > 0 ? '+' : ''}${curve.maxCumR}R · Đáy: ${curve.minCumR > 0 ? '+' : ''}${curve.minCumR}R\n` +
            `Hiện tại: ${last.cumR > 0 ? '+' : ''}${last.cumR}R` +
            (curve.skipped > 0 ? `\n(${curve.skipped} lệnh không có SL, không tính R)` : '')
        );
        return;
    }

    // Alert: BTC > 70k  |  Alert: ETH < 2400  (Pro)
    const alertMatch = text.match(/^alert:\s*(\S+)\s*([<>])\s*(\S+)\s*$/i);
    if (alertMatch) {
        const limits = await planService.getLimits(userId);
        if (limits.maxActiveAlerts === 0) {
            await ctx.reply('🔒 Price Alerts là tính năng Pro. Gõ /upgrade để nâng cấp!');
            return;
        }
        const rawTicker = alertMatch[1];
        if (!isValidTicker(rawTicker)) {
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: BTC, ETH, SOL`);
            return;
        }
        const ticker = rawTicker.toUpperCase();
        const target = parsePrice(alertMatch[3]);
        if (target === undefined) {
            await ctx.reply('⚠️ Giá target không hợp lệ. Ví dụ: Alert: BTC > 70k');
            return;
        }
        if (limits.maxActiveAlerts !== -1 && await alertService.countActive(userId) >= limits.maxActiveAlerts) {
            await ctx.reply(`⚠️ Đã đạt giới hạn ${limits.maxActiveAlerts} alerts. Xoá bớt (gõ Alerts) hoặc /upgrade lên Premium.`);
            return;
        }
        const condition = alertMatch[2] === '>' ? 'above' : 'below';
        const alert = await alertService.addAlert(userId, ticker, condition, target);
        if (!alert) {
            await ctx.reply('⚠️ Không thể tạo alert. Vui lòng thử lại.');
            return;
        }
        // Best-effort: echo current price and warn if condition is already met.
        let extra = '';
        try {
            const prices = await marketService.getPrices([ticker]);
            const cur = prices.get(ticker);
            if (cur !== undefined) {
                const alreadyHit = condition === 'above' ? cur >= target : cur <= target;
                extra = `\nGiá hiện tại: ${formatPrice(cur)}` +
                    (alreadyHit ? '\n⚠️ Điều kiện đã thoả ngay bây giờ, alert sẽ kích hoạt ở lần check tới.' : '');
            }
        } catch { /* ignore */ }
        await ctx.reply(
            `🔔 Đã đặt alert ${ticker} ${condition === 'above' ? '>' : '<'} ${formatPrice(target)}.\n` +
            `Bot check giá mỗi phút và báo khi chạm.${extra}`
        );
        return;
    }

    // Alerts / My Alerts — list active alerts with delete buttons
    if (text.toLowerCase() === 'alerts' || text.toLowerCase() === 'my alerts') {
        const limits = await planService.getLimits(userId);
        if (limits.maxActiveAlerts === 0) {
            await ctx.reply('🔒 Price Alerts là tính năng Pro. Gõ /upgrade để nâng cấp!');
            return;
        }
        const active = await alertService.getActiveAlerts(userId);
        if (active.length === 0) {
            await ctx.reply('🔕 Chưa có alert nào đang chạy. Đặt alert: Alert: BTC > 70k');
            return;
        }
        const keyboard = new InlineKeyboard();
        active.forEach((a) => {
            keyboard.text(
                `🗑 ${a.ticker} ${a.condition === 'above' ? '>' : '<'} ${formatPrice(a.targetPrice)}`,
                `alertdel:${a.id}`
            ).row();
        });
        await ctx.reply(`🔔 Alerts đang chạy (${active.length}). Bấm để xoá:`, { reply_markup: keyboard });
        return;
    }

    // Watch: BTC — add ticker to watchlist
    const watchMatch = text.match(/^watch:\s*(\S+)\s*$/i);
    if (watchMatch) {
        const rawTicker = watchMatch[1];
        if (!isValidTicker(rawTicker)) {
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: BTC, ETH, SOL`);
            return;
        }
        const ticker = rawTicker.toUpperCase();
        const limits = await planService.getLimits(userId);
        if (limits.maxWatchlist !== -1 && await watchlistService.count(userId) >= limits.maxWatchlist) {
            await ctx.reply(`⚠️ Watchlist free tối đa ${limits.maxWatchlist} ticker. Gõ /upgrade lên Pro để theo dõi không giới hạn.`);
            return;
        }
        const res = await watchlistService.add(userId, ticker);
        await ctx.reply(res === 'added'
            ? `👁 Đã thêm ${ticker} vào watchlist. Gõ Watchlist để xem giá.`
            : `ℹ️ ${ticker} đã có trong watchlist rồi.`);
        return;
    }

    // Unwatch: BTC — remove ticker from watchlist
    const unwatchMatch = text.match(/^unwatch:\s*(\S+)\s*$/i);
    if (unwatchMatch) {
        const ticker = unwatchMatch[1].toUpperCase();
        const ok = await watchlistService.remove(userId, ticker);
        await ctx.reply(ok ? `🗑 Đã xoá ${ticker} khỏi watchlist.` : `⚠️ ${ticker} không có trong watchlist.`);
        return;
    }

    // Watchlist — live price + 24h change for each ticker
    if (text.toLowerCase() === 'watchlist') {
        const tickers = await watchlistService.getWatchlist(userId);
        if (tickers.length === 0) {
            await ctx.reply('💹 Watchlist trống. Thêm ticker: Watch: BTC');
            return;
        }
        await ctx.replyWithChatAction('typing');
        const stats = await marketService.get24hStats(tickers);
        const lines = tickers.map((t) => {
            const s = stats.get(t);
            if (!s) return `⚪ ${t}: n/a (không có trên Binance)`;
            const e = s.changePercent >= 0 ? '🟢' : '🔴';
            return `${e} ${t}: ${formatPrice(s.price)} (${fmtPct(Math.round(s.changePercent * 10) / 10)})`;
        });
        await ctx.reply(`💹 Watchlist\n${lines.join('\n')}`);
        return;
    }

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
        await userService.updateUser(userId, { fullName: newName });
        aiService.refreshSession(userId);
        await ctx.reply(`Hello ${newName}! I have remembered your name.`);
        return;
    }

    const jobMatch = text.match(/my job is (.+)/i) || text.match(/i work as (.+)/i);
    if (jobMatch) {
        const newJob = jobMatch[1].trim();
        await userService.updateUser(userId, { jobTitle: newJob });
        aiService.refreshSession(userId);
        await ctx.reply(`I have noted that your job is: ${newJob}`);
        return;
    }

    if (text.toLowerCase().startsWith('remember:')) {
        const note = text.substring(9).trim();
        await userService.addNote(userId, note);
        aiService.refreshSession(userId);
        await ctx.reply('Note added to your profile.');
        return;
    }

    // 3. Save to Docs (Command OR Forward) — ENHANCED with Research OS
    const isForward = isForwarded(ctx.message);
    const isSaveCommand = text.toLowerCase().startsWith('save:');

    if (isSaveCommand || isForward) {
        let content = text;
        if (isSaveCommand) {
            content = text.substring(5).trim();
        }

        // --- Rate limiting for free users ---
        const forwardCheck = await planService.canForward(userId);
        if (!forwardCheck.allowed) {
            await ctx.reply(
                `⚠️ Bạn đã dùng hết ${forwardCheck.limit} forwards/ngày (Free plan).\n\n` +
                `Nâng cấp Pro để forward không giới hạn!\n` +
                `Gõ /plan để xem chi tiết.`
            );
            return;
        }

        const targetDocId = await userService.getActiveDocId(userId) || config.googleDocId;

        // --- Save to Research Service (auto-tag) ---
        const forwardFrom = getForwardSource(ctx.message);
        const researchItem = await researchService.addItem(userId, content, forwardFrom);
        await planService.incrementForwardCount(userId);
        await maybeRewardReferral(userId);

        // --- Thesis conflict detection (Premium) ---
        let thesisAlert = '';
        if (await planService.canUse(userId, 'canThesis') && researchItem.sentiment !== 0) {
            const conflicts: ThesisItem[] = [];
            const seen = new Set<string>();
            for (const ticker of researchItem.tickers) {
                const tickerConflicts = await thesisService.findConflicts(userId, ticker, researchItem.sentiment);
                for (const t of tickerConflicts) {
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
        const catInfo = researchItem.categories.filter((c) => c !== 'general').length > 0
            ? `\n📂 ${researchItem.categories.filter((c) => c !== 'general').join(', ')}`
            : '';
        const sentimentEmoji = researchItem.sentiment > 0.2 ? '🟢' : researchItem.sentiment < -0.2 ? '🔴' : '🟡';
        const sentimentInfo = researchItem.sentiment !== 0
            ? `\n${sentimentEmoji} Sentiment: ${researchItem.sentiment > 0 ? '+' : ''}${researchItem.sentiment.toFixed(2)}`
            : '';

        // --- Also save to Google Docs ---
        if (targetDocId) {
            try {
                await googleService.appendToDocs(targetDocId, `${content}`);
                const source = isForward ? 'forwarded message' : 'content';
                try {
                    await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❤' }]);
                    if (tagInfo || catInfo) {
                        await ctx.reply(`📊 Research saved!${tagInfo}${catInfo}${sentimentInfo}`);
                    }
                } catch (e) {
                    await ctx.reply(`✅ Saved ${source} to Google Docs${tagInfo}${catInfo}${sentimentInfo}`);
                }
            } catch (error) {
                await ctx.reply(`✅ Research saved locally${tagInfo}${catInfo}${sentimentInfo}${await docSyncErrorReason(error, targetDocId)}`);
            }
        } else {
            await ctx.reply(`✅ Research saved!${tagInfo}${catInfo}${sentimentInfo}\n💡 Tip: Add Doc [name] [ID] để sync với Google Docs.`);
        }

        // Show remaining quota for free users
        const remaining = await planService.canForward(userId);
        if (remaining.limit !== -1 && remaining.remaining <= 3 && remaining.remaining > 0) {
            await ctx.reply(`⚡ Còn ${remaining.remaining}/${remaining.limit} forwards hôm nay.`);
        }

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

    const isForward = isForwarded(ctx.message);
    const hasSaveKeyword = /save/i.test(caption);

    if (!hasSaveKeyword && !isForward) {
        return;
    }

    await ctx.replyWithChatAction('upload_photo');

    const forwardCheck = await planService.canForward(userId);
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
                const targetDocId = await userService.getActiveDocId(userId) || config.googleDocId;

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

                    if (cleanCaption) {
                        const forwardFrom = getForwardSource(ctx.message);
                        await researchService.addItem(userId, `[Image] ${cleanCaption}`, forwardFrom);
                        await maybeRewardReferral(userId);
                    }
                    await planService.incrementForwardCount(userId);

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
                const targetDocId = await userService.getActiveDocId(userId) || config.googleDocId;
                await ctx.reply(`⚠️ Lưu ảnh vào Docs thất bại.${await docSyncErrorReason(docError, targetDocId)}`);
            }
        }
    } catch (error) {
        console.error('Photo handling error', error);
        await ctx.reply('Error handling photo.');
    }
});

// --- DAILY DIGEST CRON JOB ---
cron.schedule('0 8 * * *', async () => {
    console.log('[Digest] Running daily digest cron...');

    const [eligibleUsers, allResearchUsers] = await Promise.all([
        planService.getDigestEligibleUsers(),
        researchService.getAllUserIds(),
    ]);
    const usersToDigest = [...new Set([...eligibleUsers, ...allResearchUsers])];

    for (const userId of usersToDigest) {
        try {
            const digestData = await researchService.getDigestData(userId, 24);
            if (digestData.totalItems === 0) continue;

            const digest = await aiService.generateDigest(digestData);
            const priceBlock = await buildPriceBlock(digestData.topTickers.map((t) => t.ticker));
            await bot.api.sendMessage(userId, `📬 Daily Research Digest\n\n${digest}${priceBlock}`);
            console.log(`[Digest] Sent digest to user ${userId} (${digestData.totalItems} items)`);
        } catch (error) {
            console.error(`[Digest] Error sending digest to user ${userId}:`, error);
        }
    }

    await planService.checkExpiredPlans();
    console.log('[Digest] Daily digest cron completed.');
}, {
    timezone: 'Asia/Ho_Chi_Minh',
});

// --- WEEKLY REPORT CRON JOB ---
cron.schedule('0 18 * * 0', async () => {
    console.log('[Weekly] Running weekly report cron...');

    const [eligibleUsers, allResearchUsers] = await Promise.all([
        planService.getDigestEligibleUsers(),
        researchService.getAllUserIds(),
    ]);
    const usersToReport = [...new Set([...eligibleUsers, ...allResearchUsers])];

    for (const userId of usersToReport) {
        try {
            if (!await planService.canUse(userId, 'canDigest')) continue;
            const weeklyData = await researchService.getWeeklyReportData(userId);
            if (weeklyData.totalItems === 0) continue;

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

// --- PRICE ALERT CHECKER CRON (every minute) ---
let alertCronBusy = false;
cron.schedule('* * * * *', async () => {
    if (alertCronBusy) return; // skip if a previous run is still in flight
    alertCronBusy = true;
    try {
        const active = await alertService.getAllActive();
        if (active.length === 0) return;

        const tickers = [...new Set(active.map((a) => a.ticker))];
        const prices = await marketService.getPrices(tickers);

        for (const a of active) {
            const price = prices.get(a.ticker);
            if (price === undefined) continue;
            const hit = a.condition === 'above' ? price >= a.targetPrice : price <= a.targetPrice;
            if (!hit) continue;

            // Mark triggered BEFORE sending — a send failure must not re-fire forever.
            await alertService.markTriggered(a.id);
            try {
                await bot.api.sendMessage(
                    a.userId,
                    `🔔 Price Alert: ${a.ticker} đã ${a.condition === 'above' ? 'vượt' : 'thủng'} ${formatPrice(a.targetPrice)}\n` +
                    `Giá hiện tại: ${formatPrice(price)}`
                );
            } catch (e) {
                console.error(`[Alerts] send failed for user ${a.userId}:`, e);
            }
            await new Promise((r) => setTimeout(r, 150)); // Telegram rate-limit cushion
        }
    } catch (e) {
        console.error('[Alerts] cron error:', e);
    } finally {
        alertCronBusy = false;
    }
}, {
    timezone: 'Asia/Ho_Chi_Minh',
});

// --- EOD PROCESS-AUDIT CRON ("perfect trader" ledger, 21:00 daily) ---
cron.schedule('0 21 * * *', async () => {
    console.log('[Audit] Running EOD process-audit cron...');
    try {
        const userIds = await tradeService.getAllUserIds();
        for (const userId of userIds) {
            try {
                if (!await planService.canUse(userId, 'canTrade')) continue;
                const dstate = await disciplineService.getState(userId);
                if (!dstate.enabled) continue;
                const unaudited = (await tradeService.getUnauditedClosedToday(userId)).slice(0, 5);
                if (unaudited.length === 0) continue;

                await bot.api.sendMessage(
                    userId,
                    `🧭 Đối soát cuối ngày: ${unaudited.length} lệnh đóng hôm nay chưa review.\n` +
                    'Đánh giá theo QUY TRÌNH, không theo kết quả:'
                );
                for (const t of unaudited) {
                    await bot.api.sendMessage(
                        userId,
                        `${auditLabel(t)}\nLệnh này có đúng quy trình không?`,
                        { reply_markup: auditKeyboard(t.id) }
                    );
                    await new Promise((r) => setTimeout(r, 150)); // Telegram rate-limit cushion
                }
            } catch (e) {
                console.error(`[Audit] Error for user ${userId}:`, e);
            }
        }
    } catch (e) {
        console.error('[Audit] cron error:', e);
    }
    console.log('[Audit] EOD process-audit cron completed.');
}, {
    timezone: 'Asia/Ho_Chi_Minh',
});

// --- /invite command (referral program) ---
bot.command('invite', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const link = `https://t.me/${bot.botInfo.username}?start=ref_${userId}`;
    const count = await referralService.getRewardedCount(userId);

    let msg =
        `🔗 Mời bạn bè dùng EdgeBook:\n${link}\n\n` +
        `Khi người được mời lưu research đầu tiên, cả hai nhận +7 ngày Pro!\n\n` +
        `✅ Đã mời thành công: ${count} người`;

    if (count < 3) {
        msg += `\n🏆 Mời đủ 3 người: +30 ngày Pro`;
    } else if (count < 10) {
        msg += `\n👑 Mời đủ 10 người: +30 ngày Premium`;
    }

    await ctx.reply(msg);
});

// --- /growth command (admin-only growth dashboard) ---
bot.command('growth', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !planService.isAdmin(userId)) return;

    const report = await growthService.getReport();
    await ctx.reply(report);
});

// --- /upgrade command ---
bot.command('upgrade', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const plan = await planService.getPlan(userId);
    const hasIntl = !!config.lsApiKey;
    const hasVn = sepayService.isConfigured();

    if (!hasIntl && !hasVn) {
        await ctx.reply('⚠️ Tính năng thanh toán chưa được kích hoạt. Vui lòng liên hệ admin.');
        return;
    }

    if (plan.tier === 'premium') {
        await ctx.reply('💎 Bạn đang dùng Premium, plan cao nhất! Cảm ơn đã ủng hộ 🙏');
        return;
    }

    const keyboard = new InlineKeyboard()
        .text('⭐ Pro', 'upgrade_pro')
        .row()
        .text('💎 Premium', 'upgrade_premium');

    const currentTierText = plan.tier === 'pro'
        ? 'Bạn đang dùng ⭐ Pro. Upgrade lên 💎 Premium để mở khoá Sentiment & Export.'
        : 'Chọn plan muốn nâng cấp:';

    const proPrice = hasVn ? `$9.99/tháng (~${sepayService.getPrice('pro').toLocaleString('vi-VN')}đ)` : '$9.99/tháng';
    const premiumPrice = hasVn ? `$24.99/tháng (~${sepayService.getPrice('premium').toLocaleString('vi-VN')}đ)` : '$24.99/tháng';

    await ctx.reply(
        `💳 Nâng cấp EdgeBook\n\n${currentTierText}\n\n` +
        `⭐ Pro (${proPrice}):\n• Unlimited forwards\n• Search & Tag\n• Daily Digest\n• Ask AI\n\n` +
        `💎 Premium (${premiumPrice}):\n• Tất cả Pro features\n• Sentiment scoring\n• Export research\n• Unlimited Docs`,
        { reply_markup: keyboard }
    );
});

// Send a LemonSqueezy checkout link (international cards)
async function sendLsCheckout(ctx: Context, userId: number, tier: 'pro' | 'premium'): Promise<void> {
    await ctx.reply('⏳ Đang tạo link thanh toán...');
    const url = await paymentService.createCheckoutLink(userId, tier);

    if (!url) {
        await ctx.reply('❌ Không thể tạo link thanh toán. Vui lòng thử lại sau hoặc liên hệ admin.');
        return;
    }

    const tierLabel = tier === 'pro' ? '⭐ Pro ($9.99/tháng)' : '💎 Premium ($24.99/tháng)';
    await ctx.reply(
        `${tierLabel} — link thanh toán thẻ quốc tế:\n\n${url}\n\n` +
        `⏰ Link có hiệu lực trong 30 phút.\n` +
        `Sau khi thanh toán, plan sẽ tự động cập nhật! 🚀`
    );
}

// Send a SePay VietQR code for direct bank-transfer payment (VN users)
async function sendSepayQuote(ctx: Context, userId: number, tier: 'pro' | 'premium'): Promise<void> {
    const { qrUrl, amount, content } = sepayService.generateQuote(userId, tier);
    const tierLabel = tier === 'pro' ? '⭐ Pro' : '💎 Premium';

    await ctx.replyWithPhoto(qrUrl, {
        caption:
            `${tierLabel} — Chuyển khoản VietQR\n\n` +
            `Số tiền: ${amount.toLocaleString('vi-VN')}đ\n` +
            `Nội dung CK: ${content}\n\n` +
            `Quét mã hoặc chuyển khoản đúng nội dung và số tiền trên. Hệ thống tự nhận diện và nâng cấp plan trong vài giây, không cần làm gì thêm.`,
    });
}

// Pick a payment method: skip the menu if only one is configured.
async function choosePaymentMethod(ctx: Context, userId: number, tier: 'pro' | 'premium'): Promise<void> {
    const hasIntl = !!config.lsApiKey;
    const hasVn = sepayService.isConfigured();

    if (hasIntl && hasVn) {
        const keyboard = new InlineKeyboard()
            .text('💳 Thẻ quốc tế', `pay:${tier}:intl`)
            .row()
            .text('🇻🇳 Chuyển khoản VietQR', `pay:${tier}:vn`);
        const tierLabel = tier === 'pro' ? '⭐ Pro' : '💎 Premium';
        await ctx.reply(`${tierLabel} — chọn phương thức thanh toán:`, { reply_markup: keyboard });
    } else if (hasVn) {
        await sendSepayQuote(ctx, userId, tier);
    } else if (hasIntl) {
        await sendLsCheckout(ctx, userId, tier);
    } else {
        await ctx.reply('❌ Chưa cấu hình phương thức thanh toán. Liên hệ admin.');
    }
}

// Handle upgrade inline keyboard callbacks
bot.callbackQuery('upgrade_pro', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    await choosePaymentMethod(ctx, userId, 'pro');
});

bot.callbackQuery('upgrade_premium', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    await choosePaymentMethod(ctx, userId, 'premium');
});

// Handle payment-method selection (only shown when both methods are configured)
bot.callbackQuery(/^pay:(pro|premium):(intl|vn)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const tier = ctx.match[1] as 'pro' | 'premium';
    const method = ctx.match[2] as 'intl' | 'vn';

    if (method === 'intl') {
        await sendLsCheckout(ctx, userId, tier);
    } else {
        await sendSepayQuote(ctx, userId, tier);
    }
});

// Research-to-trade link callbacks (Premium)
bot.callbackQuery(/^linkres:([^:]+):([^:]+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    if (!await planService.canUse(userId, 'canLinkResearch')) {
        await ctx.answerCallbackQuery({ text: '🔒 Tính năng Premium', show_alert: true });
        return;
    }
    const tradeId = ctx.match![1];
    const researchId = ctx.match![2];

    const [research, tradeLookup] = await Promise.all([
        researchService.getItemById(userId, researchId),
        tradeService.getTradeById(userId, tradeId),
    ]);

    if (!research || !tradeLookup) {
        await ctx.answerCallbackQuery({ text: '⚠️ Không tìm thấy lệnh hoặc research', show_alert: true });
        return;
    }
    const trade = await tradeService.linkResearch(userId, tradeId, researchId);
    if (!trade) {
        await ctx.answerCallbackQuery({ text: '⚠️ Lỗi khi link research', show_alert: true });
        return;
    }
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

// Delete-alert callbacks (from the Alerts list)
bot.callbackQuery(/^alertdel:(.+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    const ok = await alertService.deleteAlert(userId, ctx.match![1]);
    await ctx.answerCallbackQuery(ok ? { text: '✅ Đã xoá alert' } : { text: '⚠️ Alert không tồn tại', show_alert: true });
    if (!ok) return;

    const active = await alertService.getActiveAlerts(userId);
    if (active.length === 0) {
        await ctx.editMessageText('🔕 Không còn alert nào đang chạy.');
        return;
    }
    const keyboard = new InlineKeyboard();
    active.forEach((a) => {
        keyboard.text(
            `🗑 ${a.ticker} ${a.condition === 'above' ? '>' : '<'} ${formatPrice(a.targetPrice)}`,
            `alertdel:${a.id}`
        ).row();
    });
    await ctx.editMessageText(`🔔 Alerts đang chạy (${active.length}). Bấm để xoá:`, { reply_markup: keyboard });
});

// --- DISCIPLINE CALLBACKS ---

// Fetch the caller's pending trade if it's still fresh; expired entries are cleaned up.
function getFreshPending(userId: number): PendingTrade | null {
    const pending = pendingTrades.get(userId);
    if (!pending) return null;
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
        pendingTrades.delete(userId);
        return null;
    }
    return pending;
}

// Safety-gate checklist toggle
bot.callbackQuery(/^dchk:(\d)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    const pending = getFreshPending(userId);
    if (!pending) {
        await ctx.answerCallbackQuery({ text: '⌛ Phiên đã hết hạn. Gõ lại Trade: để mở lệnh.', show_alert: true });
        await ctx.editMessageText('⌛ Chốt an toàn đã hết hạn. Gõ lại Trade: nếu vẫn muốn vào lệnh.');
        return;
    }
    const idx = parseInt(ctx.match![1], 10);
    if (idx >= 0 && idx < pending.checks.length) {
        pending.checks[idx] = !pending.checks[idx];
    }
    await ctx.answerCallbackQuery();
    try {
        await ctx.editMessageReplyMarkup({ reply_markup: safetyKeyboard(pending) });
    } catch {
        // "message is not modified" when toggling fast — safe to ignore.
    }
});

// Safety-gate unlock: requires all checks + the 15s delay elapsed.
bot.callbackQuery('dgo', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    const pending = getFreshPending(userId);
    if (!pending) {
        await ctx.answerCallbackQuery({ text: '⌛ Phiên đã hết hạn. Gõ lại Trade: để mở lệnh.', show_alert: true });
        await ctx.editMessageText('⌛ Chốt an toàn đã hết hạn. Gõ lại Trade: nếu vẫn muốn vào lệnh.');
        return;
    }
    if (!pending.checks.every(Boolean)) {
        await ctx.answerCallbackQuery({ text: '⚠️ Tick đủ 3 mục checklist trước đã.', show_alert: true });
        return;
    }
    const waitLeft = Math.ceil((SAFETY_DELAY_MS - (Date.now() - pending.createdAt)) / 1000);
    if (waitLeft > 0) {
        await ctx.answerCallbackQuery({ text: `⏳ Còn ${waitLeft}s. Hít thở sâu đã.` });
        try {
            await ctx.editMessageReplyMarkup({ reply_markup: safetyKeyboard(pending) });
        } catch {
            // unchanged countdown label — ignore
        }
        return;
    }
    pendingTrades.delete(userId);
    const trade = await tradeService.openTrade(userId, pending.params);
    if (!trade) {
        await ctx.answerCallbackQuery({ text: '⚠️ Không thể mở lệnh.', show_alert: true });
        await ctx.editMessageText('⚠️ Không thể mở lệnh: giá không hợp lệ. Gõ lại Trade: để thử lại.');
        return;
    }
    await ctx.answerCallbackQuery({ text: '🔓 Đã mở chốt!' });
    await ctx.editMessageText('🛡 Checklist hoàn tất sau 15s — kỷ luật tốt.\n\n' + buildOpenReply(trade));
    await sendOpenFollowups((t, o) => ctx.reply(t, o), trade);
});

bot.callbackQuery('dcancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) pendingTrades.delete(userId);
    await ctx.answerCallbackQuery({ text: 'Đã huỷ' });
    await ctx.editMessageText('✖️ Đã huỷ lệnh. Không vào được lệnh xấu cũng là một chiến thắng.');
});

// Emotion score buttons (after opening a trade)
bot.callbackQuery(/^emo:([^:]+):(\d{1,2})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    const tradeId = ctx.match![1];
    const score = parseInt(ctx.match![2], 10);
    const trade = await tradeService.setEmotion(userId, tradeId, { score });
    if (!trade) {
        await ctx.answerCallbackQuery({ text: '⚠️ Không tìm thấy lệnh', show_alert: true });
        return;
    }
    await ctx.answerCallbackQuery({ text: `Đã ghi ${score}/10` });
    await ctx.editMessageText(`🧠 Cảm xúc lúc vào lệnh ${trade.ticker}: ${score}/10.`);
    const warn = emotionWarning(score, trade.heartRate);
    if (warn) await ctx.reply(warn);
});

bot.callbackQuery(/^emoskip:.+$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('👍 Đã bỏ qua chấm điểm cảm xúc.');
});

// Process-audit buttons ("perfect trader" ledger + compassionate post-loss voice)
bot.callbackQuery(/^audit:([^:]+):(0|1)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
        await ctx.answerCallbackQuery();
        return;
    }
    const tradeId = ctx.match![1];
    const ok = ctx.match![2] === '1';
    const trade = await tradeService.setDisciplined(userId, tradeId, ok);
    if (!trade) {
        await ctx.answerCallbackQuery({ text: '⚠️ Không tìm thấy lệnh', show_alert: true });
        return;
    }
    await ctx.answerCallbackQuery({ text: ok ? '✅ Đúng quy trình' : '❌ Đã ghi nhận vi phạm' });
    const pnl = trade.pnlPercent ?? 0;
    const isWin = pnl > 0;
    let msg: string;
    if (ok && !isWin) {
        msg = `🙏 ${auditLabel(trade)}\n` +
            'Bạn đã làm đúng quy trình. Lỗ này là chi phí kinh doanh, không phải thất bại.\n' +
            'Tha thứ cho bản thân và bước tiếp. Sự sáng tỏ quan trọng hơn một lệnh thua.';
    } else if (ok && isWin) {
        msg = `✅ ${auditLabel(trade)}\n` +
            'Thắng đúng quy trình — đây mới là lợi nhuận bền vững. Giữ vững phong độ.';
    } else if (!ok && isWin) {
        msg = `⚖️ ${auditLabel(trade)}\n` +
            `Đã loại ${fmtPct(pnl)} khỏi PnL kỷ luật. Lợi nhuận may mắn là khoản thị trường sẽ đòi lại.\n` +
            'Giữ cái tôi khiêm tốn — quy trình mới là thứ kiếm tiền dài hạn.';
    } else {
        msg = `📝 ${auditLabel(trade)}\n` +
            'Ghi nhận để học, không phải để tự trách. Lệnh sau quay lại đúng kế hoạch là đủ.';
    }
    await ctx.editMessageText(msg);
});

// Slash commands shown in Telegram's command menu.
const BOT_COMMANDS = [
    { command: 'start', description: '👋 Khởi động & giới thiệu EdgeBook' },
    { command: 'help', description: '📓 Hướng dẫn sử dụng & danh sách lệnh' },
    { command: 'plan', description: '💳 Xem gói hiện tại & giới hạn' },
    { command: 'upgrade', description: '⭐ Nâng cấp Pro / Premium' },
    { command: 'invite', description: '🔗 Mời bạn, cả hai nhận +7 ngày Pro' },
];

// Global error handler — prevents bot from crashing on unhandled errors (e.g. DB failures)
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error handling update ${ctx.update.update_id}:`, err.error);
});

// Start webhook server (runs alongside bot polling)
startWebhookServer(paymentService, sepayService, bot);

// Start the bot
bot.start({
    onStart: async (botInfo) => {
        console.log(`EdgeBook bot @${botInfo.username} started!`);
        console.log('EdgeBook features enabled: auto-tag, search, digest, star, stats, trade journal');
        console.log('Payment: /upgrade command enabled' + (config.lsApiKey ? '' : ' (⚠️ LS keys not set)'));
        console.log('Payment: SePay VietQR ' + (sepayService.isConfigured() ? 'enabled' : '(⚠️ SEPAY_* not set)'));
        try {
            await bot.api.setMyCommands(BOT_COMMANDS);
            console.log(`Registered ${BOT_COMMANDS.length} bot commands in the "/" menu.`);
        } catch (e) {
            console.error('Failed to register bot commands:', e);
        }
    },
});
