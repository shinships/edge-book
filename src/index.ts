import { Bot, Context, InlineKeyboard, InputFile } from 'grammy';
import { config, oauthEnabled } from './config';
import { AIService } from './services/ai.service';
import { GoogleService, GoogleApiError } from './services/google.service';
import { GoogleOAuthService } from './services/google-oauth.service';
import { UserService } from './services/user.service';
import { TodoService } from './services/todo.service';
import { ResearchService } from './services/research.service';
import { PlanService } from './services/plan.service';
import { SepayService } from './services/sepay.service';
import { TradeService } from './services/trade.service';
import { ReportService } from './services/report.service';
import { ThesisService, ThesisItem } from './services/thesis.service';
import { MarketService } from './services/market.service';
import { VnStockService } from './services/vn-stock.service';
import { CafefService, flowStreak, InsiderTx } from './services/cafef.service';
import { PnfService } from './services/pnf.service';
import { renderPnfImage } from './services/pnf-image';
import { MarketRouter } from './services/market-router';
import { AlertService, AlertType, AlertItem } from './services/alert.service';
import { WatchlistService } from './services/watchlist.service';
import { PortfolioService } from './services/portfolio.service';
import { DisciplineService } from './services/discipline.service';
import { GrowthService } from './services/growth.service';
import { ReferralService } from './services/referral.service';
import { TradeItem } from './services/trade.service';
import { startWebhookServer } from './webhook.server';
import cron from 'node-cron';

const bot = new Bot(config.telegramBotToken);
const aiService = new AIService();
const googleService = new GoogleService();
const oauthService = new GoogleOAuthService();
const todoService = new TodoService();
const userService = new UserService();
const researchService = new ResearchService();
const planService = new PlanService(config.adminUserIds);
const sepayService = new SepayService(planService);
const tradeService = new TradeService();
const reportService = new ReportService();
const thesisService = new ThesisService();
const marketService = new MarketService();
const vnStockService = new VnStockService();
const cafefService = new CafefService();
const pnfService = new PnfService();
const marketRouter = new MarketRouter(marketService, vnStockService);
const alertService = new AlertService();
const watchlistService = new WatchlistService();
const portfolioService = new PortfolioService();
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

// Market-aware price format. VN stock prices are in thousand-VND units (e.g. 24.35 =
// 24,350đ) so the crypto "k" compaction is wrong for them — show 2 trimmed decimals.
function formatPriceMkt(value: number, market?: 'crypto' | 'vn'): string {
    if (market === 'vn') {
        return value.toFixed(2).replace(/\.?0+$/, '');
    }
    return formatPrice(value);
}

// Compact a share count → "50 triệu cp" / "6,6 triệu cp" / "450K cp" (VN comma decimal).
function fmtShares(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0 cp';
    if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace('.', ',')} triệu cp`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K cp`;
    return `${n} cp`;
}

// One human line for an insider/related-person filing.
function formatInsiderTx(t: InsiderTx): string {
    const who = t.isRelated && t.relatedTo
        ? `${t.person} (${t.role || 'NLQ'} của ${t.relatedTo})`
        : `${t.person}${t.role ? ` · ${t.role}` : ''}`;
    const act = t.side === 'buy' ? '🟢 ĐK MUA' : t.side === 'sell' ? '🔴 ĐK BÁN' : 'ĐK';
    const win = t.beginDate && t.endDate ? ` · ${t.beginDate}→${t.endDate}` : '';
    const realVol = t.realBuy || t.realSell;
    const real = realVol ? ` · đã ${t.realBuy ? 'mua' : 'bán'} ${fmtShares(realVol)}` : '';
    const pub = t.publishedDate ? `[${t.publishedDate}] ` : '';
    return `${pub}${who}\n   ${act} ${fmtShares(t.planVolume)}${win}${real}`;
}

// Compact a raw VND amount to a tỷ/triệu string (foreign flow, portfolio NAV/P&L).
function fmtVnd(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(1)} tỷ`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(0)} tr`;
    return `${Math.round(value)}`;
}

// Market-aware money amount (portfolio cost / value / P&L). VN money values are carried
// in thousand-VND units (shares × thousand-VND price) → ×1000 to get VND for fmtVnd.
function fmtMoney(value: number, market: 'crypto' | 'vn'): string {
    if (market === 'vn') return `${fmtVnd(value * 1000)}đ`;
    return `$${formatPrice(value)}`;
}

// Short human label for an alert (price alerts show the price; VN alerts their condition).
function describeAlert(a: AlertItem): string {
    const streakN = Number(a.params?.streakDays ?? 1);
    const streakTxt = streakN > 1 ? ` ≥${streakN} phiên` : '';
    const thrTxt = a.targetPrice > 0 ? ` ≥${a.targetPrice} tỷ` : '';
    switch (a.alertType) {
        case 'foreign': return `${a.ticker} khối ngoại ${a.condition === 'above' ? 'mua ròng' : 'bán ròng'}${thrTxt}${streakTxt}`;
        case 'proprietary': return `${a.ticker} tự doanh ${a.condition === 'above' ? 'mua ròng' : 'bán ròng'}${thrTxt}${streakTxt}`;
        case 'volume': return `${a.ticker} volume ≥ ${a.targetPrice}x TB20`;
        case 'rsi': return `${a.ticker} RSI ${a.condition === 'above' ? '>' : '<'} ${a.targetPrice}`;
        case 'macross': return `${a.ticker} MA20×MA50`;
        case 'insider': return `${a.ticker} giao dịch nội bộ (đăng ký mới)`;
        default: return `${a.ticker} ${a.condition === 'above' ? '>' : '<'} ${formatPriceMkt(a.targetPrice, marketRouter.classify(a.ticker))}`;
    }
}

// Best-effort live-price block for digests. Returns '' on any failure so the
// digest always sends, with or without prices.
async function buildPriceBlock(tickers: string[]): Promise<string> {
    try {
        const top = tickers.slice(0, 5);
        if (top.length === 0) return '';
        const stats = await marketRouter.get24hStats(top);
        const lines = top
            .map((t) => {
                const s = stats.get(t);
                if (!s) return null;
                const e = s.changePercent >= 0 ? '🟢' : '🔴';
                return `${e} ${t}: ${formatPriceMkt(s.price, s.market)} (${fmtPct(Math.round(s.changePercent * 10) / 10)})`;
            })
            .filter((l): l is string => l !== null);
        return lines.length > 0 ? `\n\n💹 Giá hiện tại:\n${lines.join('\n')}` : '';
    } catch (e) {
        console.error('[Digest] price enrichment skipped:', e);
        return '';
    }
}

// Footer + "Share" button appended to digest messages — viral loop: tapping
// the button lets the recipient pick a chat with a teaser + bot link pre-filled.
function digestShareExtras(): { footer: string; keyboard: InlineKeyboard } {
    const username = bot.botInfo.username;
    const footer = `\n\n— 🤖 EdgeBook · t.me/${username}`;
    const keyboard = new InlineKeyboard().switchInline(
        '↗️ Chia sẻ',
        `Research OS tự tag ticker + chấm sentiment, gửi digest mỗi sáng. Thử xem: t.me/${username}`
    );
    return { footer, keyboard };
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

// Users who tapped "Connect Docs" and are expected to paste a Google Doc URL next.
// Map<userId, expiresAt>. TTL avoids accidentally swallowing a doc URL the user
// shares hours later in a different context. In-memory: not durable, but the cost
// of losing it is small (user just types Connect Docs again).
const pendingDocConnect = new Map<number, number>();
const PENDING_DOC_CONNECT_TTL_MS = 30 * 60_000;
const DOC_URL_RE = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/;

function isPendingDocConnect(userId: number): boolean {
    const exp = pendingDocConnect.get(userId);
    if (!exp) return false;
    if (Date.now() > exp) { pendingDocConnect.delete(userId); return false; }
    return true;
}

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

async function sendConnectDocsInstructions(ctx: Context, userId: number): Promise<void> {
    // Preferred path: OAuth one-tap — bot tạo Doc trong Drive của user, không cần
    // share service-account email thủ công.
    if (oauthEnabled) {
        const existing = await oauthService.getConnection(userId);
        if (existing) {
            const link = existing.docId ? `\n🔗 ${docUrl(existing.docId)}` : '';
            await ctx.reply(
                `✅ Bạn đã kết nối Google Docs rồi${existing.email ? ` (${existing.email})` : ''}.${link}\n` +
                `Gõ Disconnect Docs nếu muốn ngắt.`,
                { link_preview_options: { is_disabled: true } },
            );
            return;
        }
        const url = oauthService.getAuthUrl(userId);
        const kb = new InlineKeyboard().url('🔗 Kết nối bằng tài khoản Google', url);
        await ctx.reply(
            '📎 Kết nối Google Docs (tuỳ chọn)\n\n' +
            'Bấm nút dưới, đăng nhập Google và đồng ý — bot sẽ tự tạo 1 Doc EdgeBook Research ' +
            'trong Drive của bạn và lưu mọi research vào đó. Không cần copy ID hay share email.',
            { reply_markup: kb },
        );
        return;
    }

    // Fallback (OAuth chưa cấu hình): hướng dẫn share service-account email thủ công.
    const sa = googleService.getServiceAccountEmail();
    if (!sa) {
        await ctx.reply(
            '📎 Kết nối Google Docs (tuỳ chọn)\n\n' +
            'Bot đang thiếu thông tin service account — không thể hướng dẫn share email. ' +
            'Liên hệ admin hoặc dùng Add Doc [tên] [ID] thủ công.'
        );
        return;
    }
    pendingDocConnect.set(userId, Date.now() + PENDING_DOC_CONNECT_TTL_MS);
    await ctx.reply(
        '📎 <b>Kết nối Google Docs</b> (tuỳ chọn)\n\n' +
        'Bot sẽ append research vào 1 Doc của riêng bạn — tiện để backup / chia sẻ.\n\n' +
        '<b>3 bước:</b>\n' +
        '1) Tạo 1 Google Doc trống (hoặc dùng doc có sẵn)\n' +
        '2) Mở Doc → Share → paste email này (quyền <b>Editor</b>):\n' +
        `   <code>${sa}</code>   ← chạm để copy\n` +
        '3) Copy URL của Doc rồi paste vào đây — bot tự nhận ID',
        { parse_mode: 'HTML' }
    );
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
    let trialHint = '';
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

        // Gợi ý trial cho user mới chưa từng dùng — bước đệm thấp dẫn lên Pro.
        if (isNew && sepayService.isConfigured() && !(await planService.hasUsedTrial(userId))) {
            const trialPrice = sepayService.getPrice('trial').toLocaleString('vi-VN');
            trialHint = `\n🎁 Mới? Trải nghiệm full Pro 7 ngày chỉ ${trialPrice}đ — gõ /upgrade rồi chọn Trial.\n`;
        }
    }
    return ctx.reply(
        '👋 EdgeBook · capture your edge.\n' +
        'Research OS cho trader, sống ngay trong Telegram.\n' +
        '\n' +
        '✨ Nổi bật:\n' +
        '📥 Forward tin → tự gắn tag ticker, chấm sentiment\n' +
        '📊 Daily Digest + Weekly Report tổng hợp research bằng AI\n' +
        '🔍 Search & Ask: hỏi AI ngay trên kho research của bạn\n' +
        '📈 Trade Journal: log lệnh, tính PnL, win rate, analytics\n' +
        '🧠 Thesis tracker: cảnh báo khi tin mới mâu thuẫn luận điểm\n' +
        trialHint +
        '\n👉 Thử ngay: forward 1 bài báo bất kỳ vào đây — bot tự tag & lưu.\n' +
        'Gõ /help để xem tất cả lệnh.'
    );
});

bot.command('help', (ctx) => {
    ctx.reply(
        '📓 EdgeBook · Lệnh\n' +
        '\n' +
        '⚡ Gõ tắt (nhập nhanh)\n' +
        't: Trade · c: Close · w: Watch · a: Alert\n' +
        'b: Buy · s: Sell · q: Ask · f: Search · th: Thesis\n' +
        '+ [việc] thêm task · wl Watchlist · pf Portfolio\n' +
        'VD: t: Long BTC entry 108k SL 105k TP 115k\n' +
        '\n' +
        '💬 Chat & cá nhân\n' +
        '• Hỏi AI bất kỳ về trading/đầu tư (free 1, Pro 20, Premium 60/ngày)\n' +
        '• Save: [nội dung] hoặc forward tin/ảnh → tự tag + lưu (sv:)\n' +
        '• Recent — xem 10 research mới nhất\n' +
        '• Call me [tên] · My job is [nghề]\n' +
        '\n' +
        '✅ To-Do & lịch\n' +
        '• + [việc] · List Tasks · Complete Task: [số]\n' +
        '• Remind me… → tạo nhắc lịch\n' +
        '\n' +
        '📊 Research OS (Pro)\n' +
        '• Search: [từ khoá] (f:) · Tag: [ticker] · Ask: [câu hỏi] (q:)\n' +
        '• Digest · Weekly · Stats · Starred · Star\n' +
        '• Thesis: [ticker] bullish|bearish [ý] (Premium) · Theses · Close Thesis: [số]\n' +
        '\n' +
        '📈 Trade Journal (Pro)\n' +
        '• Trade: Long BTC entry 108k SL 105k TP 115k (t:)\n' +
        '  +tuỳ chọn: size 500 risk 1% fee 0.1% setup breakout emo 7 hr 95\n' +
        '• Close: BTC 112k · +3.2% · 105k sl (c:)\n' +
        '• Trades · Trade Stats · Trade Analytics · Equity · Export PDF (Premium)\n' +
        '\n' +
        '🧠 Discipline (Pro)\n' +
        '• Trade: qua chốt an toàn 15s + checklist (mặc định bật)\n' +
        '• Discipline [on/off] · Limit: [1-10] · Review\n' +
        '\n' +
        '💹 Market & Alerts (crypto: Binance · cổ phiếu VN: VNDirect)\n' +
        '• Watch: BTC / HPG (w:) · Unwatch: … · Watchlist (wl)\n' +
        '• Alert: BTC > 70k · HPG > 30 (a:) · Alerts\n' +
        '• Alert VN cuối phiên: HPG foreign buy 50 3p · HPG tudoanh buy · volume 2x · rsi > 70 · ma cross\n' +
        '   (50 = ròng ≥50 tỷ · 3p = ≥3 phiên liên tiếp · lặp mỗi phiên)\n' +
        '• 💰 Digest dòng tiền lớn tự gửi 15:30 mỗi phiên (NN + tự doanh mã bạn theo dõi)\n' +
        '• 📐 PnF: HPG — đồ thị Point & Figure (X/O) + tín hiệu mua/bán, giá mục tiêu\n' +
        '• 👔 Insider: HPG — giao dịch nội bộ + người liên quan · Alert: HPG insider (báo ĐK mới)\n' +
        '• 🔍 Screener: oversold / golden / pnf buy / foreign buy — quét VN30 (thêm wl: chỉ watchlist)\n' +
        '\n' +
        '📊 Danh mục (Pro)\n' +
        '• Buy: HPG 1000 @ 25.5 (b:) · Sell: HPG 500 @ 28 (s:)\n' +
        '• Portfolio (pf) · Position: HPG\n' +
        '\n' +
        '💳 Tài khoản\n' +
        '• /plan · /upgrade · /invite (mời bạn, cả hai +7 ngày Pro)\n' +
        '\n' +
        '💾 Google Docs (tuỳ chọn — backup ra Doc)\n' +
        '• Connect Docs — kết nối 1 chạm (tự tạo Doc) · Disconnect Docs\n' +
        '• New Doc [tên] — tạo thêm doc · Use Doc [số|tên] · List Docs · Current Doc'
    );
});

// NOTE: /upgrade, /invite, /growth must be registered BEFORE the generic
// message:text handler below. grammY runs middleware in registration order and
// the message:text handler doesn't call next(), so any bot.command() declared
// after it would never fire (the text would fall through to AI chat instead).
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
// TODO(intl-payments): For international launch, add a payment-method selection step here.
// When both SePay and LemonSqueezy are configured, show an InlineKeyboard asking the user
// to pick "💳 Thẻ quốc tế" (→ sendLsCheckout) or "🇻🇳 Chuyển khoản" (→ sendSepayQuote).
// Callback pattern was: pay:(pro|premium):(intl|vn). See git history (Sprint 10-14) for
// the removed choosePaymentMethod() helper and sendLsCheckout() implementation.
bot.command('upgrade', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const plan = await planService.getPlan(userId);

    if (!sepayService.isConfigured()) {
        await ctx.reply('⚠️ Tính năng thanh toán chưa được kích hoạt. Vui lòng liên hệ admin.');
        return;
    }

    if (plan.tier === 'premium') {
        await ctx.reply('💎 Bạn đang dùng Premium, plan cao nhất! Cảm ơn đã ủng hộ 🙏');
        return;
    }

    // Trial chỉ hiện cho user free chưa từng dùng — gate kép (UI + activateTrial check)
    // để khoá đường tắt lạm dụng.
    const trialAvailable = plan.tier === 'free' && !plan.trialUsedAt;
    const trialPrice = `${sepayService.getPrice('trial').toLocaleString('vi-VN')}đ`;

    const keyboard = new InlineKeyboard();
    if (trialAvailable) {
        keyboard.text(`🎁 Trial 7 ngày — ${trialPrice}`, 'upgrade_trial').row();
    }
    keyboard.text('⭐ Pro', 'upgrade_pro').row().text('💎 Premium', 'upgrade_premium');

    const currentTierText = plan.tier === 'pro'
        ? 'Bạn đang dùng ⭐ Pro. Upgrade lên 💎 Premium để mở khoá Sentiment & Export.'
        : 'Chọn plan muốn nâng cấp:';

    const proPrice = `${sepayService.getPrice('pro').toLocaleString('vi-VN')}đ/tháng`;
    const premiumPrice = `${sepayService.getPrice('premium').toLocaleString('vi-VN')}đ/tháng`;

    const trialLine = trialAvailable
        ? `🎁 Trial 7 ngày (${trialPrice}): full quyền Pro, sau 7 ngày tự về Free, không tự động gia hạn, chỉ mua được 1 lần.\n\n`
        : '';

    await ctx.reply(
        `💳 Nâng cấp EdgeBook\n\n${currentTierText}\n\n` +
        trialLine +
        `⭐ Pro (${proPrice}):\n• Unlimited forwards\n• Search & Tag\n• Daily Digest\n• Ask AI\n\n` +
        `💎 Premium (${premiumPrice}):\n• Tất cả Pro features\n• Sentiment scoring\n• Export research\n• Unlimited Docs`,
        { reply_markup: keyboard }
    );
});

// Quick shortcuts — short forms expand to the canonical command text once at the
// top of the handler, so every matcher below stays unchanged. Cuts typing on the
// commands traders hit most. Only known keys expand; anything else passes through.
const COLON_SHORTCUTS: Record<string, string> = {
    t: 'Trade', c: 'Close', w: 'Watch', uw: 'Unwatch', a: 'Alert',
    b: 'Buy', s: 'Sell', sv: 'Save', q: 'Ask', f: 'Search', th: 'Thesis',
    pos: 'Position',
};
const WORD_SHORTCUTS: Record<string, string> = { wl: 'Watchlist', pf: 'Portfolio' };
function expandShortcut(raw: string): string {
    const t = raw.trim();
    // "+ việc" → quick add task
    const plus = t.match(/^\+\s*(.+)$/s);
    if (plus) return `Add Task: ${plus[1].trim()}`;
    // one-word view shortcuts (wl, pf)
    const word = WORD_SHORTCUTS[t.toLowerCase()];
    if (word) return word;
    // "<short>: rest" → "<Full>: rest"
    const m = t.match(/^([a-z]{1,3}):\s*([\s\S]*)$/i);
    if (m) {
        const full = COLON_SHORTCUTS[m[1].toLowerCase()];
        if (full) return `${full}: ${m[2].trim()}`;
    }
    return raw;
}

// General Chat Handler
bot.on('message:text', async (ctx) => {
    let text = ctx.message.text;
    const userId = ctx.from?.id;

    await ctx.replyWithChatAction('typing');

    if (!userId) {
        await ctx.reply('Error: Unknown User ID.');
        return;
    }

    // Expand quick shortcuts (skip forwarded messages — those go to research save).
    if (!isForwarded(ctx.message)) text = expandShortcut(text);

    // --- CONNECT DOCS FLOW (paste-URL step) ---
    // If user just tapped "Connect Docs" and is expected to paste a doc URL,
    // intercept BEFORE the save handler so the URL isn't stored as research.
    if (isPendingDocConnect(userId) && !isForwarded(ctx.message)) {
        const m = text.match(DOC_URL_RE);
        if (m) {
            pendingDocConnect.delete(userId);
            const docId = m[1];
            await userService.setDocAlias(userId, 'docs', docId);
            try {
                await googleService.appendToDocs(docId, '[EdgeBook connected ✅]');
                await ctx.reply(
                    `✅ Đã kết nối Google Docs!\n` +
                    `Mọi forward / Save: từ giờ sẽ được append vào doc này.\n` +
                    `🔗 ${docUrl(docId)}`,
                    { link_preview_options: { is_disabled: true } }
                );
            } catch (error) {
                await ctx.reply(
                    `⚠️ Đã lưu ID nhưng chưa append được.${await docSyncErrorReason(error, docId)}\n` +
                    `Sau khi sửa quyền, gõ Current Doc để xác nhận.`,
                    { link_preview_options: { is_disabled: true } }
                );
            }
            return;
        }
        // Not a doc URL — fall through (user may have changed their mind / pasted something else).
        // Don't clear the flag; let them try again or use other commands.
    }

    // --- RECENT / NOTES: list newest research in Telegram ---
    if (/^(recent|notes|my notes|gần đây)$/i.test(text)) {
        const items = await researchService.getNewest(userId, 10);
        if (items.length === 0) {
            await ctx.reply('📝 Chưa có research nào. Forward 1 bài báo hoặc gõ Save: [nội dung] để thử.');
            return;
        }
        const lines = items.map((it, i) => {
            const d = new Date(it.createdAt);
            const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
            const tickerStr = it.tickers.length > 0 ? ` 🏷️ ${it.tickers.join(',')}` : '';
            const preview = it.content.replace(/\s+/g, ' ').slice(0, 80);
            return `${i + 1}) ${dateStr}${tickerStr}\n   ${preview}${it.content.length > 80 ? '…' : ''}`;
        });
        await ctx.reply(`📝 Research gần đây (${items.length})\n\n${lines.join('\n\n')}`);
        return;
    }

    // --- CONNECT DOCS (entry point) ---
    if (/^connect docs$/i.test(text)) {
        await sendConnectDocsInstructions(ctx, userId);
        return;
    }

    if (/^disconnect docs$/i.test(text)) {
        const ok = await oauthService.disconnect(userId);
        await ctx.reply(ok
            ? '🔌 Đã ngắt kết nối Google Docs. Research vẫn được lưu trong bot (Recent / Search / Ask vẫn chạy).'
            : '⚠️ Bạn chưa kết nối Google Docs qua OAuth. (Gõ Connect Docs để kết nối.)');
        return;
    }

    // New Doc <tên> — chỉ cho user đã kết nối OAuth: bot tạo doc mới trong Drive của
    // user, thêm vào danh sách và đặt làm active. (drive.file scope chỉ ghi được vào
    // doc do bot tạo, nên không trỏ được doc user tự tạo sẵn.)
    const newDocMatch = text.match(/^new doc\s+(.+)$/i);
    if (newDocMatch) {
        const name = stripWrappers(newDocMatch[1]).slice(0, 100);
        const conn = await oauthService.getConnection(userId);
        if (!conn) {
            await ctx.reply('⚠️ Cần kết nối Google trước. Gõ Connect Docs.');
            return;
        }
        if (!name) {
            await ctx.reply('⚠️ Cú pháp: New Doc tên-doc');
            return;
        }
        const doc = await oauthService.createDoc(userId, name);
        if (doc) {
            await ctx.reply(
                `✅ Đã tạo doc "${doc.name}" và đặt làm doc đang dùng.\n🔗 ${docUrl(doc.id)}`,
                { link_preview_options: { is_disabled: true } }
            );
        } else {
            await ctx.reply('⚠️ Tạo doc thất bại. Thử lại hoặc Connect Docs lại.');
        }
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

    if (['list docs', 'docs', 'my docs'].includes(text.toLowerCase())) {
        // OAuth-connected users manage their OAuth docs here (research goes to these).
        const conn = await oauthService.getConnection(userId);
        if (conn) {
            if (conn.docs.length === 0) {
                await ctx.reply('📚 Chưa có doc nào. Gõ New Doc tên-doc để tạo.');
                return;
            }
            const lines = conn.docs.map((d, i) => {
                const active = d.id === conn.docId ? ' ✅ (đang dùng)' : '';
                return `${i + 1}) ${d.name}${active}\n   🔗 ${docUrl(d.id)}`;
            });
            await ctx.reply(
                `📚 Docs của bạn (${conn.docs.length})\n\n${lines.join('\n\n')}\n\n` +
                `Chuyển: Use Doc [số|tên] · Tạo mới: New Doc [tên]`,
                { link_preview_options: { is_disabled: true } }
            );
            return;
        }
        const user = await userService.getUser(userId);
        const entries = Object.entries(user.docAliases ?? {});
        if (entries.length === 0) {
            if (config.googleDocId) {
                await ctx.reply(
                    `📚 Bạn chưa thêm Doc nào.\nĐang dùng system default:\n🔗 ${docUrl(config.googleDocId)}\n\nThêm doc: Add Doc [tên] [ID]`,
                    { link_preview_options: { is_disabled: true } }
                );
            } else {
                await ctx.reply('📚 Bạn chưa thêm Doc nào. Thêm bằng: Add Doc [tên] [ID]');
            }
            return;
        }
        const lines = entries.map(([alias, id]) => {
            const active = id === user.activeDocId ? ' ✅ (đang dùng)' : '';
            return `🏷️ ${alias}${active}\n   🔗 ${docUrl(id)}`;
        });
        await ctx.reply(
            `📚 Docs của bạn (${entries.length})\n\n${lines.join('\n\n')}\n\nChuyển: Use Doc [tên] · Thêm: Add Doc [tên] [ID]`,
            { link_preview_options: { is_disabled: true } }
        );
        return;
    }

    const setDocMatch = text.match(/^use doc\s+(.+)$/i);
    if (setDocMatch) {
        const arg = stripWrappers(setDocMatch[1]);
        // OAuth-connected users switch among their OAuth docs (by index or name).
        const conn = await oauthService.getConnection(userId);
        if (conn) {
            const doc = await oauthService.setActiveDoc(userId, arg);
            if (doc) {
                await ctx.reply(`✅ Đang dùng doc: ${doc.name}\n🔗 ${docUrl(doc.id)}`,
                    { link_preview_options: { is_disabled: true } });
            } else {
                await ctx.reply('⚠️ Không tìm thấy doc đó. Gõ List Docs để xem số thứ tự.');
            }
            return;
        }
        if (await userService.setActiveDoc(userId, arg)) {
            await ctx.reply(`✅ Switched to Doc: ${arg}`);
        } else {
            await ctx.reply(`⚠️ Doc "${arg}" not found. Use Add Doc first.`);
        }
        return;
    }

    if (text.toLowerCase() === 'current doc') {
        // OAuth connection takes priority — it's where research actually goes.
        const oauthConn = await oauthService.getConnection(userId);
        if (oauthConn) {
            const activeDoc = oauthConn.docs.find((d) => d.id === oauthConn.docId);
            const nameLine = activeDoc ? `\n📄 ${activeDoc.name}` : '';
            const link = oauthConn.docId ? `\n🔗 ${docUrl(oauthConn.docId)}` : '';
            const more = oauthConn.docs.length > 1 ? `\n(${oauthConn.docs.length} doc · chuyển: Use Doc [số])` : '';
            await ctx.reply(
                `📂 Current Doc: Google${oauthConn.email ? ` (${oauthConn.email})` : ''}${nameLine}${link}${more}\n` +
                `Tạo thêm: New Doc [tên] · Ngắt: Disconnect Docs`,
                { link_preview_options: { is_disabled: true } }
            );
            return;
        }
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
        const { footer, keyboard } = digestShareExtras();
        await ctx.reply(digest + priceBlock + footer, { reply_markup: keyboard });
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
                botUsername: bot.botInfo.username,
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

    // Insider transactions (Pro) — giao dịch cổ đông nội bộ + người liên quan (CafeF). VN only.
    {
        const im = text.match(/^(?:insider|nội ?bộ|noi ?bo|nb)\s*:?\s*([a-z0-9]{2,7})\s*$/i);
        if (im) {
            const limits = await planService.getLimits(userId);
            if (limits.maxActiveAlerts === 0) {
                await ctx.reply('🔒 Giao dịch nội bộ là tính năng Pro. Gõ /upgrade để mở khoá!');
                return;
            }
            const rawTicker = im[1];
            if (!isValidTicker(rawTicker)) {
                await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: Insider: HPG`);
                return;
            }
            const ticker = rawTicker.toUpperCase();
            if (marketRouter.classify(ticker) !== 'vn') {
                await ctx.reply('⚠️ Giao dịch nội bộ chỉ áp dụng cho cổ phiếu VN (vd HPG, FPT, SSI).');
                return;
            }
            const txs = await cafefService.getInsiderTransactions(ticker, 5);
            if (txs.length === 0) {
                await ctx.reply(`📋 ${ticker}: chưa có dữ liệu giao dịch nội bộ gần đây (hoặc nguồn tạm gián đoạn).`);
                return;
            }
            const body = txs.map(formatInsiderTx).join('\n\n');
            await ctx.reply(
                `👔 Giao dịch nội bộ ${ticker} (mới nhất)\n\n${body}\n\n` +
                `Đặt cảnh báo khi có đăng ký mới: Alert: ${ticker} insider`
            );
            return;
        }
    }

    // Point & Figure chart (Pro) — ASCII grid + tín hiệu. Cổ phiếu VN (cần OHLC bars).
    {
        const pm = text.match(/^(?:pnf|p&f|p ?và ?f|point.?and.?figure)\s*:?\s*([a-z0-9]{2,7})(?:\s+(\d+(?:\.\d+)?))?(?:\s+r\s*(\d+))?\s*$/i);
        if (pm) {
            const limits = await planService.getLimits(userId);
            if (limits.maxActiveAlerts === 0) {
                await ctx.reply('🔒 Point & Figure là tính năng Pro. Gõ /upgrade để mở khoá!');
                return;
            }
            const rawTicker = pm[1];
            if (!isValidTicker(rawTicker)) {
                await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: PnF: HPG`);
                return;
            }
            const ticker = rawTicker.toUpperCase();
            if (marketRouter.classify(ticker) !== 'vn') {
                await ctx.reply('⚠️ Point & Figure hiện hỗ trợ cổ phiếu VN (vd HPG, FPT, SSI).');
                return;
            }
            const box = pm[2] ? parseFloat(pm[2]) : undefined;
            const reversal = pm[3] ? parseInt(pm[3], 10) : undefined;
            const bars = await vnStockService.getDailyBars(ticker, 260);
            if (bars.length < 20) {
                await ctx.reply(`⚠️ Chưa đủ dữ liệu để vẽ P&F cho ${ticker}.`);
                return;
            }
            const result = pnfService.compute(bars.map((b) => ({ h: b.h, l: b.l, c: b.c })), { box, reversal });
            if (!result) {
                await ctx.reply(`⚠️ Không dựng được đồ thị P&F cho ${ticker}.`);
                return;
            }
            const png = renderPnfImage(result, ticker);
            const cur = result.columns[result.columns.length - 1];
            // P&F signal is a *prevailing state* (stays until an opposing signal forms),
            // distinct from the current column (the live X/O leg, which may be a pullback).
            const sig = result.signal === 'buy'
                ? '🟢 Trạng thái: ĐANG TRÊN TÍN HIỆU MUA (double-top)'
                : result.signal === 'sell'
                    ? '🔴 Trạng thái: ĐANG TRÊN TÍN HIỆU BÁN (double-bottom)'
                    : '➖ Trạng thái: chưa có tín hiệu P&F rõ ràng';
            const colNow = `Cột hiện tại: ${cur.dir === 'X' ? 'X (giá đang đẩy lên)' : 'O (giá đang chỉnh xuống)'}`;
            let note = '';
            if (result.signal === 'buy' && cur.dir === 'O') note = '\n⚠️ Đang nhịp chỉnh (cột O) bên trong xu hướng mua.';
            else if (result.signal === 'sell' && cur.dir === 'X') note = '\n⚠️ Đang hồi kỹ thuật (cột X) bên trong xu hướng bán.';
            const dec = result.box < 1 ? 1 : 0;
            const target = result.priceTarget !== undefined
                ? `\n🎯 Mục tiêu kỹ thuật (vertical count, ${result.signal === 'buy' ? 'lên' : 'xuống'}): ~${result.priceTarget.toFixed(dec)}`
                : '';
            const header = `📐 ${ticker} · Point & Figure · ${result.reversal} ô đảo chiều · box ${result.box}`;
            const caption = `${header}\n${sig}\n${colNow}${note}${target}\n\nX = giá tăng · O = giá giảm · giá nghìn đ · Giá hiện tại: ${result.lastPrice}`;
            await ctx.replyWithPhoto(new InputFile(png, `pnf-${ticker}.png`), { caption });
            return;
        }
    }

    // Quick Screener (Pro) — quét VN30 (hoặc watchlist) theo 1 tiêu chí kỹ thuật/dòng tiền.
    {
        const sm = text.match(/^(?:screener|screen|scan|lọc|loc)\s*:?\s*(.*)$/i);
        if (sm) {
            const limits = await planService.getLimits(userId);
            if (limits.maxActiveAlerts === 0) {
                await ctx.reply('🔒 Screener là tính năng Pro. Gõ /upgrade để mở khoá!');
                return;
            }
            const rest = sm[1].trim();
            if (!rest) {
                await ctx.reply(
                    '🔍 Screener nhanh — quét VN30 theo 1 tiêu chí:\n\n' +
                    '• Screener: oversold (RSI ≤ 30) · overbought · rsi < 25\n' +
                    '• Screener: volume 2 (vol ≥ 2x TB20)\n' +
                    '• Screener: golden / death (MA20 x MA50)\n' +
                    '• Screener: pnf buy / pnf sell\n' +
                    '• Screener: foreign buy / tudoanh buy (dòng tiền lớn)\n\n' +
                    'Thêm wl để chỉ quét watchlist, vd: Screener: oversold wl'
                );
                return;
            }
            const useWatchlist = /\b(wl|watchlist|theo dõi|theo doi|danh mục|danh muc)\b/i.test(rest);
            const filterRaw = rest.replace(/\b(wl|watchlist|theo dõi|theo doi|danh mục|danh muc)\b/ig, '').trim();
            const f = parseScreenFilter(filterRaw);
            if (!f) {
                await ctx.reply('⚠️ Chưa hiểu tiêu chí. Gõ Screener (không kèm gì) để xem các tiêu chí hỗ trợ.');
                return;
            }
            let universe = useWatchlist ? await trackedVnTickers(userId) : VN30_UNIVERSE;
            if (universe.length === 0) {
                await ctx.reply('📭 Watchlist của bạn chưa có mã VN nào để quét. Thêm bằng Watch: HPG.');
                return;
            }
            universe = universe.slice(0, 30);
            await ctx.replyWithChatAction('typing');
            const hits = (await Promise.all(universe.map((t) => evalScreen(t, f)))).filter((h): h is ScreenHit => h !== null);
            if (f.id === 'oversold') hits.sort((a, b) => a.metric - b.metric);
            else hits.sort((a, b) => b.metric - a.metric);
            const scope = useWatchlist ? 'watchlist' : 'VN30';
            if (hits.length === 0) {
                await ctx.reply(`🔍 Screener · ${f.label}\nKhông có mã nào trong ${scope} khớp tiêu chí (đã quét ${universe.length} mã).`);
                return;
            }
            const lines = hits.slice(0, 15).map((h, i) => `${i + 1}. ${h.ticker} — ${h.note}`);
            const more = hits.length > 15 ? `\n…và ${hits.length - 15} mã khác` : '';
            await ctx.reply(
                `🔍 Screener · ${f.label}\n` +
                `Quét ${scope} (${universe.length} mã) → ${hits.length} mã khớp:\n\n` +
                `${lines.join('\n')}${more}\n\n` +
                `Xem chi tiết: PnF: ${hits[0].ticker} · Insider: ${hits[0].ticker}`
            );
            return;
        }
    }

    // VN stock alerts (Pro, evaluated end-of-day): khối ngoại / volume / RSI / MA cross.
    // Matched BEFORE the generic price alert so multi-token forms aren't misparsed.
    {
        let parsed: { type: AlertType; condition: 'above' | 'below'; target: number; rawTicker: string; desc: string; params?: Record<string, any> } | null = null;
        let m: RegExpMatchArray | null;
        // Money flow: Alert: HPG foreign buy [50] [3p]  — 50 = ngưỡng ròng (tỷ), 3p = ≥3 phiên liên tiếp.
        // Tự doanh: Alert: HPG tudoanh buy [50] [3p]. Threshold & streak đều tuỳ chọn (mặc định 1 phiên, không ngưỡng).
        if ((m = text.match(/^alert:\s*(\S+)\s+(foreign|nn|khoingoai|tudoanh|td|proprietary|prop)\s+(buy|sell|mua|ban)(?:\s+(\d+(?:\.\d+)?)\s*(?:ty|tỷ|bn|b)?)?(?:\s+(\d+)\s*p(?:hien|hiên)?)?\s*$/i))) {
            const kind = m[2].toLowerCase();
            const isProp = /^(tudoanh|td|proprietary|prop)$/.test(kind);
            const buy = /^(buy|mua)$/i.test(m[3]);
            const thr = m[4] ? parseFloat(m[4]) : 0;       // ngưỡng tỷ đồng (0 = không ngưỡng)
            const streak = m[5] ? Math.max(1, parseInt(m[5], 10)) : 1;
            const label = isProp ? 'tự doanh' : 'khối ngoại';
            const desc = `${label} ${buy ? 'mua ròng' : 'bán ròng'}` +
                (thr > 0 ? ` ≥${thr} tỷ` : '') + (streak > 1 ? ` ≥${streak} phiên liên tiếp` : '');
            parsed = {
                type: isProp ? 'proprietary' : 'foreign',
                rawTicker: m[1], condition: buy ? 'above' : 'below', target: thr, desc,
                params: { streakDays: streak, recurring: true },
            };
        } else if ((m = text.match(/^alert:\s*(\S+)\s+vol(?:ume)?\s+(\d+(?:\.\d+)?)x?\s*$/i))) {
            parsed = { type: 'volume', rawTicker: m[1], condition: 'above', target: parseFloat(m[2]), desc: `volume ≥ ${parseFloat(m[2])}x TB20 phiên` };
        } else if ((m = text.match(/^alert:\s*(\S+)\s+rsi\s*([<>])\s*(\d+(?:\.\d+)?)\s*$/i))) {
            parsed = { type: 'rsi', rawTicker: m[1], condition: m[2] === '>' ? 'above' : 'below', target: parseFloat(m[3]), desc: `RSI(14) ${m[2]} ${parseFloat(m[3])}` };
        } else if ((m = text.match(/^alert:\s*(\S+)\s+ma\s*cross\s*$/i))) {
            parsed = { type: 'macross', rawTicker: m[1], condition: 'above', target: 0, desc: 'MA20 cắt MA50 (golden/death)' };
        } else if ((m = text.match(/^alert:\s*(\S+)\s+(insider|noi ?bo|nội ?bộ|nb)\s*$/i))) {
            parsed = { type: 'insider', rawTicker: m[1], condition: 'above', target: 0, desc: 'giao dịch nội bộ (đăng ký mới)', params: { recurring: true } };
        }
        if (parsed) {
            const limits = await planService.getLimits(userId);
            if (limits.maxActiveAlerts === 0) {
                await ctx.reply('🔒 Price Alerts là tính năng Pro. Gõ /upgrade để nâng cấp!');
                return;
            }
            if (!isValidTicker(parsed.rawTicker)) {
                await ctx.reply(`⚠️ Ticker "${parsed.rawTicker}" không hợp lệ. Ví dụ: HPG, FPT, SSI`);
                return;
            }
            const ticker = parsed.rawTicker.toUpperCase();
            if (marketRouter.classify(ticker) !== 'vn') {
                await ctx.reply('⚠️ Alert khối ngoại/volume/RSI/MA chỉ áp dụng cho cổ phiếu VN (vd HPG, FPT).');
                return;
            }
            if (parsed.type === 'volume' && parsed.target <= 0) {
                await ctx.reply('⚠️ Hệ số volume không hợp lệ. Ví dụ: Alert: HPG volume 2x');
                return;
            }
            if (parsed.type === 'rsi' && (parsed.target <= 0 || parsed.target > 100)) {
                await ctx.reply('⚠️ Ngưỡng RSI phải trong 1-100. Ví dụ: Alert: HPG rsi > 70');
                return;
            }
            if (limits.maxActiveAlerts !== -1 && await alertService.countActive(userId) >= limits.maxActiveAlerts) {
                await ctx.reply(`⚠️ Đã đạt giới hạn ${limits.maxActiveAlerts} alerts. Xoá bớt (gõ Alerts) hoặc /upgrade lên Premium.`);
                return;
            }
            // Insider alerts only fire on FUTURE filings → baseline lastSeen to the latest current one.
            if (parsed.type === 'insider') {
                const latest = await cafefService.getInsiderTransactions(ticker, 1);
                parsed.params = { ...parsed.params, lastSeen: latest[0]?.publishedMs ?? 0 };
            }
            const alert = await alertService.addAlert(userId, ticker, parsed.condition, parsed.target, parsed.type, parsed.params);
            if (!alert) {
                await ctx.reply('⚠️ Không thể tạo alert. Vui lòng thử lại.');
                return;
            }
            const recurring = parsed.params?.recurring === true;
            await ctx.reply(
                `🔔 Đã đặt alert ${ticker}: ${parsed.desc}.\n` +
                `Bot kiểm tra sau giờ đóng cửa (≈15:15) mỗi phiên và báo khi thoả.` +
                (recurring ? '\n♻️ Lặp lại mỗi phiên (theo dõi dài hạn, không tự tắt sau lần đầu).' : '')
            );
            return;
        }
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
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: BTC, ETH, HPG, FPT`);
            return;
        }
        const ticker = rawTicker.toUpperCase();
        const target = parsePrice(alertMatch[3]);
        if (target === undefined) {
            await ctx.reply('⚠️ Giá target không hợp lệ. Ví dụ: Alert: BTC > 70k hoặc Alert: HPG > 30');
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
            const prices = await marketRouter.getPrices([ticker]);
            const cur = prices.get(ticker);
            if (cur !== undefined) {
                const alreadyHit = condition === 'above' ? cur >= target : cur <= target;
                extra = `\nGiá hiện tại: ${formatPriceMkt(cur, marketRouter.classify(ticker))}` +
                    (alreadyHit ? '\n⚠️ Điều kiện đã thoả ngay bây giờ, alert sẽ kích hoạt ở lần check tới.' : '');
            }
        } catch { /* ignore */ }
        await ctx.reply(
            `🔔 Đã đặt alert ${ticker} ${condition === 'above' ? '>' : '<'} ${formatPriceMkt(target, marketRouter.classify(ticker))}.\n` +
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
                `🗑 ${describeAlert(a)}`,
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
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: BTC, ETH, HPG, FPT`);
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

    // Watchlist — live price + change for each ticker (crypto via Binance, VN via VNDirect)
    if (text.toLowerCase() === 'watchlist') {
        const tickers = await watchlistService.getWatchlist(userId);
        if (tickers.length === 0) {
            await ctx.reply('💹 Watchlist trống. Thêm ticker: Watch: BTC hoặc Watch: HPG');
            return;
        }
        await ctx.replyWithChatAction('typing');
        const stats = await marketRouter.get24hStats(tickers);

        // Enrich VN tickers with P/E + foreign net flow (best-effort, parallel; finfo host
        // may be unreachable in some environments → simply omitted when null).
        const vnExtras = new Map<string, string>();
        await Promise.all(
            tickers
                .filter((t) => marketRouter.classify(t) === 'vn')
                .map(async (t) => {
                    const [f, fund] = await Promise.all([
                        vnStockService.getForeignFlow(t),
                        vnStockService.getFundamentals(t),
                    ]);
                    const parts: string[] = [];
                    if (fund?.pe !== undefined) parts.push(`P/E ${fund.pe.toFixed(1)}`);
                    if (f) parts.push(`NN ${f.netValue >= 0 ? '+' : ''}${fmtVnd(f.netValue)}`);
                    if (parts.length) vnExtras.set(t, `  (${parts.join(' · ')})`);
                })
        );

        const lines = tickers.map((t) => {
            const s = stats.get(t);
            if (!s) return `⚪ ${t}: n/a`;
            const e = s.changePercent >= 0 ? '🟢' : '🔴';
            return `${e} ${t}: ${formatPriceMkt(s.price, s.market)} (${fmtPct(Math.round(s.changePercent * 10) / 10)})${vnExtras.get(t) ?? ''}`;
        });
        await ctx.reply(`💹 Watchlist\n${lines.join('\n')}`);
        return;
    }

    // Buy: HPG 1000 @ 25.5 — add/average-in a portfolio position (Pro+)
    const buyMatch = text.match(/^buy:\s*(\S+)\s+(\d+(?:\.\d+)?)\s*@\s*(\S+)\s*$/i);
    if (buyMatch) {
        if (!await planService.canUse(userId, 'canPortfolio')) {
            await ctx.reply('🔒 Portfolio (danh mục) là tính năng Pro. Gõ /upgrade để nâng cấp!');
            return;
        }
        const rawTicker = buyMatch[1];
        if (!isValidTicker(rawTicker)) {
            await ctx.reply(`⚠️ Ticker "${rawTicker}" không hợp lệ. Ví dụ: Buy: HPG 1000 @ 25.5`);
            return;
        }
        const ticker = rawTicker.toUpperCase();
        const qty = parseFloat(buyMatch[2]);
        const price = parsePrice(buyMatch[3]);
        if (!Number.isFinite(qty) || qty <= 0 || price === undefined) {
            await ctx.reply('⚠️ Số lượng/giá không hợp lệ. Ví dụ: Buy: HPG 1000 @ 25.5');
            return;
        }
        const market = marketRouter.classify(ticker);
        const pos = await portfolioService.buy(userId, ticker, qty, price, market);
        if (!pos) {
            await ctx.reply('⚠️ Không thể ghi nhận giao dịch. Vui lòng thử lại.');
            return;
        }
        await ctx.reply(
            `✅ Đã mua ${qty} ${ticker} @ ${formatPriceMkt(price, market)}.\n` +
            `Vị thế: ${pos.quantity} ${ticker}, giá vốn TB ${formatPriceMkt(pos.avgCost, market)} ` +
            `(vốn ${fmtMoney(pos.quantity * pos.avgCost, market)}).\n` +
            `Gõ Portfolio để xem định giá live.`
        );
        return;
    }

    // Sell: HPG 500 @ 28 — reduce/close a position, book realized PnL (Pro+)
    const sellMatch = text.match(/^sell:\s*(\S+)\s+(\d+(?:\.\d+)?)\s*@\s*(\S+)\s*$/i);
    if (sellMatch) {
        if (!await planService.canUse(userId, 'canPortfolio')) {
            await ctx.reply('🔒 Portfolio (danh mục) là tính năng Pro. Gõ /upgrade để nâng cấp!');
            return;
        }
        const ticker = sellMatch[1].toUpperCase();
        const qty = parseFloat(sellMatch[2]);
        const price = parsePrice(sellMatch[3]);
        if (!Number.isFinite(qty) || qty <= 0 || price === undefined) {
            await ctx.reply('⚠️ Số lượng/giá không hợp lệ. Ví dụ: Sell: HPG 500 @ 28');
            return;
        }
        const existing = await portfolioService.getPosition(userId, ticker);
        if (!existing) {
            await ctx.reply(`⚠️ Bạn chưa có vị thế ${ticker} trong danh mục.`);
            return;
        }
        const market = existing.market;
        const res = await portfolioService.sell(userId, ticker, qty, price);
        if (!res) {
            await ctx.reply('⚠️ Không thể ghi nhận giao dịch. Vui lòng thử lại.');
            return;
        }
        const sign = res.realized >= 0 ? '+' : '';
        const pnlEmoji = res.realized >= 0 ? '🟢' : '🔴';
        await ctx.reply(
            `✅ Đã bán ${Math.min(qty, existing.quantity)} ${ticker} @ ${formatPriceMkt(price, market)}.\n` +
            `${pnlEmoji} Lãi/lỗ thực hiện: ${sign}${fmtMoney(res.realized, market)}\n` +
            (res.closed
                ? `Đã đóng toàn bộ vị thế ${ticker}.`
                : `Còn lại: ${res.remaining} ${ticker} (giá vốn TB ${formatPriceMkt(res.avgCost, market)}).`)
        );
        return;
    }

    // Portfolio / Danh mục — live valuation (Pro+)
    if (text.toLowerCase() === 'portfolio' || text.toLowerCase() === 'danh mục' || text.toLowerCase() === 'danh muc') {
        if (!await planService.canUse(userId, 'canPortfolio')) {
            await ctx.reply('🔒 Portfolio (danh mục) là tính năng Pro. Gõ /upgrade để nâng cấp!');
            return;
        }
        const positions = await portfolioService.getPositions(userId);
        if (positions.length === 0) {
            await ctx.reply('📊 Danh mục trống. Thêm vị thế: Buy: HPG 1000 @ 25.5');
            return;
        }
        await ctx.replyWithChatAction('typing');
        const prices = await marketRouter.getPrices(positions.map((p) => p.ticker));
        const val = await portfolioService.valuate(userId, prices);

        const lines = val.positions.map((p) => {
            const head = `${p.ticker}: ${p.quantity} @ ${formatPriceMkt(p.avgCost, p.market)}`;
            if (p.marketValue === undefined) return `⚪ ${head} → giá n/a`;
            const e = (p.unrealizedPnl ?? 0) >= 0 ? '🟢' : '🔴';
            const sign = (p.unrealizedPnl ?? 0) >= 0 ? '+' : '';
            return `${e} ${head} → ${formatPriceMkt(p.price!, p.market)} ` +
                `(${sign}${p.unrealizedPct}%, ${sign}${fmtMoney(p.unrealizedPnl!, p.market)})` +
                (p.weight !== undefined ? ` · ${p.weight}%` : '');
        });

        const totalLines: string[] = [];
        for (const mk of ['vn', 'crypto'] as const) {
            const t = val.byMarket[mk];
            if (!t) continue;
            const label = mk === 'vn' ? '🇻🇳 Cổ phiếu VN' : '🪙 Crypto';
            const sign = t.unrealizedPnl >= 0 ? '+' : '';
            const pct = t.cost > 0 ? Math.round((t.unrealizedPnl / t.cost) * 1000) / 10 : 0;
            totalLines.push(
                `${label}: NAV ${fmtMoney(t.marketValue, mk)}${t.priced ? '' : ' (một phần n/a)'} · ` +
                `Lãi/lỗ ${sign}${fmtMoney(t.unrealizedPnl, mk)} (${sign}${pct}%)` +
                (t.realizedPnl !== 0 ? ` · Đã chốt ${t.realizedPnl >= 0 ? '+' : ''}${fmtMoney(t.realizedPnl, mk)}` : '')
            );
        }

        await ctx.reply(`📊 Danh mục\n${lines.join('\n')}\n\n${totalLines.join('\n')}`);
        return;
    }

    // Position: HPG — single-position detail (Pro+)
    const posMatch = text.match(/^position:\s*(\S+)\s*$/i);
    if (posMatch) {
        if (!await planService.canUse(userId, 'canPortfolio')) {
            await ctx.reply('🔒 Portfolio (danh mục) là tính năng Pro. Gõ /upgrade để nâng cấp!');
            return;
        }
        const ticker = posMatch[1].toUpperCase();
        const pos = await portfolioService.getPosition(userId, ticker);
        if (!pos) {
            await ctx.reply(`⚠️ Bạn chưa có vị thế ${ticker}. Thêm: Buy: ${ticker} 1000 @ 25.5`);
            return;
        }
        await ctx.replyWithChatAction('typing');
        const prices = await marketRouter.getPrices([ticker]);
        const cur = prices.get(ticker);
        const cost = pos.quantity * pos.avgCost;
        let body = `📊 ${ticker} (${pos.market === 'vn' ? 'CK Việt Nam' : 'Crypto'})\n` +
            `Số lượng: ${pos.quantity}\n` +
            `Giá vốn TB: ${formatPriceMkt(pos.avgCost, pos.market)} (tổng vốn ${fmtMoney(cost, pos.market)})\n`;
        if (cur !== undefined) {
            const mv = pos.quantity * cur;
            const pnl = mv - cost;
            const pct = cost > 0 ? Math.round((pnl / cost) * 1000) / 10 : 0;
            const e = pnl >= 0 ? '🟢' : '🔴';
            const sign = pnl >= 0 ? '+' : '';
            body += `Giá hiện tại: ${formatPriceMkt(cur, pos.market)}\n` +
                `${e} Giá trị: ${fmtMoney(mv, pos.market)} (${sign}${fmtMoney(pnl, pos.market)}, ${sign}${pct}%)\n`;
        } else {
            body += `Giá hiện tại: n/a\n`;
        }
        if (pos.realizedPnl !== 0) {
            body += `Đã chốt lãi/lỗ: ${pos.realizedPnl >= 0 ? '+' : ''}${fmtMoney(pos.realizedPnl, pos.market)}`;
        }
        await ctx.reply(body.trimEnd());
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

        // --- Save to Google Docs ---
        // Ưu tiên OAuth doc của user; chưa connect → SA / active doc; cuối cùng chỉ DB.
        const oauthAppend = await oauthService.appendForUser(userId, content);
        if (oauthAppend === 'ok') {
            try {
                await ctx.api.setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '❤' }]);
                if (tagInfo || catInfo) {
                    await ctx.reply(`📊 Research saved!${tagInfo}${catInfo}${sentimentInfo}`);
                }
            } catch (e) {
                await ctx.reply(`✅ Đã lưu vào Google Doc của bạn${tagInfo}${catInfo}${sentimentInfo}`);
            }
        } else if (oauthAppend === 'revoked') {
            await ctx.reply(
                `✅ Research saved!${tagInfo}${catInfo}${sentimentInfo}\n` +
                `⚠️ Mất quyền ghi Google Docs (có thể bạn đã gỡ quyền). Gõ Connect Docs để kết nối lại.`
            );
        } else if (targetDocId) {
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
            await ctx.reply(`✅ Research saved!${tagInfo}${catInfo}${sentimentInfo}`);

            // One-time Docs nag: shown exactly when user reaches 5 saves, unless dismissed.
            const user = await userService.getUser(userId);
            if (!user.docsHintDismissed) {
                const stats = await researchService.getStats(userId);
                if (stats.totalItems === 5) {
                    const kb = new InlineKeyboard()
                        .text('📎 Kết nối Google Docs', 'connectdocs').row()
                        .text('❌ Không, dùng Telegram là đủ', 'connectdocs:skip');
                    await ctx.reply(
                        '💡 Bạn đã lưu 5 research. Muốn backup tự động vào Google Doc riêng?\n' +
                        '(Tuỳ chọn — Search/Ask/Digest đều chạy được không cần Docs.)',
                        { reply_markup: kb }
                    );
                }
            }
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

    // 4. Default: Chat with AI (free tối đa 1 lần/ngày — tránh tốn token chủ đề ngoài)
    const chatQuota = await planService.canChat(userId);
    if (!chatQuota.allowed) {
        await ctx.reply(
            `🔒 Free chỉ được chat AI ${chatQuota.limit} lần/ngày (đã dùng hết hôm nay).\n` +
            `Gõ /upgrade lên Pro để chat không giới hạn, hoặc dùng các lệnh khác (Watchlist, Trades, Search...).`
        );
        return;
    }
    const response = await aiService.chat(text, userId);
    if (chatQuota.limit !== -1) await planService.incrementChatCount(userId);
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
            const { footer, keyboard } = digestShareExtras();
            await bot.api.sendMessage(userId, `📬 Daily Research Digest\n\n${digest}${priceBlock}${footer}`, { reply_markup: keyboard });
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
        // Only price alerts are intraday-evaluated here; VN foreign/volume/rsi/macross
        // run in the EOD cron below.
        const active = (await alertService.getAllActive()).filter((a) => a.alertType === 'price');
        if (active.length === 0) return;

        const tickers = [...new Set(active.map((a) => a.ticker))];
        const prices = await marketRouter.getPrices(tickers);

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
                    `🔔 Price Alert: ${a.ticker} đã ${a.condition === 'above' ? 'vượt' : 'thủng'} ${formatPriceMkt(a.targetPrice, marketRouter.classify(a.ticker))}\n` +
                    `Giá hiện tại: ${formatPriceMkt(price, marketRouter.classify(a.ticker))}`
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

// --- VN STOCK EOD ALERT HELPERS + CRON ---

// Simple moving average of the last `period` values; null if not enough data.
function sma(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

// Wilder's RSI over closing prices; null if not enough data. Returns 0-100.
function computeRSI(closes: number[], period = 14): number | null {
    if (closes.length < period + 1) return null;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

// --- QUICK SCREENER (#12) ---
// Curated large-cap VN universe (VN30-ish). Used as the default scan set so the screener
// surfaces fresh ideas, not just what the user already tracks.
const VN30_UNIVERSE = [
    'ACB', 'BCM', 'BID', 'BVH', 'CTG', 'FPT', 'GAS', 'GVR', 'HDB', 'HPG',
    'MBB', 'MSN', 'MWG', 'PLX', 'POW', 'SAB', 'SHB', 'SSB', 'SSI', 'STB',
    'TCB', 'TPB', 'VCB', 'VHM', 'VIB', 'VIC', 'VJC', 'VNM', 'VPB', 'VRE',
];

type ScreenFilterId =
    | 'oversold' | 'overbought' | 'volume' | 'golden' | 'death'
    | 'pnf_buy' | 'pnf_sell' | 'foreign_buy' | 'foreign_sell' | 'prop_buy' | 'prop_sell';

interface ParsedScreen { id: ScreenFilterId; threshold?: number; label: string; }
interface ScreenHit { ticker: string; metric: number; note: string; }

// Parse a free-text screener criterion into a structured filter. null = unrecognised.
function parseScreenFilter(raw: string): ParsedScreen | null {
    const s = raw.toLowerCase().trim();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/rsi\s*[<≤]\s*(\d{1,3})/))) return { id: 'oversold', threshold: Number(m[1]), label: `RSI ≤ ${m[1]} (quá bán)` };
    if ((m = s.match(/rsi\s*[>≥]\s*(\d{1,3})/))) return { id: 'overbought', threshold: Number(m[1]), label: `RSI ≥ ${m[1]} (quá mua)` };
    if (/oversold|quá bán|qua ban|rsi thấp|rsi thap/.test(s)) return { id: 'oversold', threshold: 30, label: 'RSI ≤ 30 (quá bán)' };
    if (/overbought|quá mua|qua mua|rsi cao/.test(s)) return { id: 'overbought', threshold: 70, label: 'RSI ≥ 70 (quá mua)' };
    if (/golden|cắt lên|cat len|ma.?up/.test(s)) return { id: 'golden', label: 'Golden cross (MA20 cắt lên MA50)' };
    if (/death|cắt xuống|cat xuong|ma.?down/.test(s)) return { id: 'death', label: 'Death cross (MA20 cắt xuống MA50)' };
    if (/(?:p&f|pnf|point.?and.?figure)\s*(?:buy|mua)/.test(s)) return { id: 'pnf_buy', label: 'P&F tín hiệu MUA (double-top)' };
    if (/(?:p&f|pnf|point.?and.?figure)\s*(?:sell|bán|ban)/.test(s)) return { id: 'pnf_sell', label: 'P&F tín hiệu BÁN (double-bottom)' };
    if (/(?:foreign|nn|ngoại|ngoai|khối ngoại|khoi ngoai)\s*(?:buy|mua)/.test(s)) return { id: 'foreign_buy', label: 'Khối ngoại MUA ròng phiên gần nhất' };
    if (/(?:foreign|nn|ngoại|ngoai|khối ngoại|khoi ngoai)\s*(?:sell|bán|ban)/.test(s)) return { id: 'foreign_sell', label: 'Khối ngoại BÁN ròng phiên gần nhất' };
    if (/(?:tudoanh|td|tự doanh|tu doanh|prop)\s*(?:buy|mua)/.test(s)) return { id: 'prop_buy', label: 'Tự doanh MUA ròng phiên gần nhất' };
    if (/(?:tudoanh|td|tự doanh|tu doanh|prop)\s*(?:sell|bán|ban)/.test(s)) return { id: 'prop_sell', label: 'Tự doanh BÁN ròng phiên gần nhất' };
    if ((m = s.match(/(?:volume|vol|thanh khoản|thanh khoan)\s*(\d+(?:\.\d+)?)?/))) {
        const thr = m[1] ? Number(m[1]) : 2;
        return { id: 'volume', threshold: thr, label: `Volume ≥ ${thr}x TB20` };
    }
    return null;
}

// Evaluate one ticker against a screener filter. Best-effort; null = no match / no data.
async function evalScreen(ticker: string, f: ParsedScreen): Promise<ScreenHit | null> {
    try {
        switch (f.id) {
            case 'oversold':
            case 'overbought': {
                const bars = await vnStockService.getDailyBars(ticker, 40);
                const rsi = computeRSI(bars.map((b) => b.c), 14);
                if (rsi === null) return null;
                const thr = f.threshold ?? (f.id === 'oversold' ? 30 : 70);
                const hit = f.id === 'oversold' ? rsi <= thr : rsi >= thr;
                if (!hit) return null;
                return { ticker, metric: rsi, note: `RSI ${rsi.toFixed(0)}` };
            }
            case 'volume': {
                const bars = await vnStockService.getDailyBars(ticker, 25);
                if (bars.length < 21) return null;
                const today = bars[bars.length - 1];
                const avg = sma(bars.slice(-21, -1).map((b) => b.v), 20);
                if (avg === null || avg <= 0) return null;
                const mult = today.v / avg;
                if (mult < (f.threshold ?? 2)) return null;
                return { ticker, metric: mult, note: `${mult.toFixed(1)}x vol` };
            }
            case 'golden':
            case 'death': {
                const closes = (await vnStockService.getDailyBars(ticker, 60)).map((b) => b.c);
                const ma20 = sma(closes, 20);
                const ma50 = sma(closes, 50);
                const ma20p = sma(closes.slice(0, -1), 20);
                const ma50p = sma(closes.slice(0, -1), 50);
                if (ma20 === null || ma50 === null || ma20p === null || ma50p === null) return null;
                const golden = ma20p <= ma50p && ma20 > ma50;
                const death = ma20p >= ma50p && ma20 < ma50;
                if (f.id === 'golden' ? !golden : !death) return null;
                return { ticker, metric: Math.abs(ma20 - ma50), note: f.id === 'golden' ? 'Golden cross' : 'Death cross' };
            }
            case 'pnf_buy':
            case 'pnf_sell': {
                const bars = await vnStockService.getDailyBars(ticker, 260);
                if (bars.length < 20) return null;
                const r = pnfService.compute(bars.map((b) => ({ h: b.h, l: b.l, c: b.c })));
                if (!r) return null;
                const want = f.id === 'pnf_buy' ? 'buy' : 'sell';
                if (r.signal !== want) return null;
                return { ticker, metric: r.lastPrice, note: want === 'buy' ? 'P&F mua' : 'P&F bán' };
            }
            case 'foreign_buy':
            case 'foreign_sell':
            case 'prop_buy':
            case 'prop_sell': {
                const isProp = f.id.startsWith('prop');
                const side: 'buy' | 'sell' = f.id.endsWith('buy') ? 'buy' : 'sell';
                const days = isProp
                    ? await cafefService.getProprietarySeries(ticker, 5)
                    : await cafefService.getForeignSeries(ticker, 5);
                if (days.length === 0) return null;
                const latest = days[0];
                const ok = side === 'buy' ? latest.netValue > 0 : latest.netValue < 0;
                if (!ok) return null;
                if (f.threshold && Math.abs(latest.netValue) < f.threshold * 1e9) return null;
                const streak = flowStreak(days, side);
                return {
                    ticker,
                    metric: Math.abs(latest.netValue),
                    note: `${fmtVnd(Math.abs(latest.netValue))}đ${streak > 1 ? ` ·${streak}p` : ''}`,
                };
            }
        }
    } catch {
        return null;
    }
    return null;
}

// Evaluate a single EOD alert against fresh VN data. Returns a trigger message, or null
// if the condition isn't met (or data is unavailable — best-effort, never throws).
async function evaluateEodAlert(a: AlertItem): Promise<string | null> {
    try {
        if (a.alertType === 'foreign' || a.alertType === 'proprietary') {
            const isProp = a.alertType === 'proprietary';
            const days = isProp
                ? await cafefService.getProprietarySeries(a.ticker, 5)
                : await cafefService.getForeignSeries(a.ticker, 5);
            if (days.length === 0) return null;
            const side: 'buy' | 'sell' = a.condition === 'above' ? 'buy' : 'sell';
            const latest = days[0];
            const matchesSide = side === 'buy' ? latest.netValue > 0 : latest.netValue < 0;
            if (!matchesSide) return null;
            // Threshold (tỷ đồng) on the latest session's |net|; 0 = no threshold.
            const thrVnd = (a.targetPrice || 0) * 1e9;
            if (thrVnd > 0 && Math.abs(latest.netValue) < thrVnd) return null;
            // Streak requirement: N consecutive same-side sessions.
            const needStreak = Math.max(1, Number(a.params?.streakDays ?? 1));
            const streak = flowStreak(days, side);
            if (streak < needStreak) return null;
            const label = isProp ? 'Tự doanh' : 'Khối ngoại';
            const emoji = side === 'buy' ? '🟢' : '🔴';
            const streakTxt = streak > 1 ? ` — phiên thứ ${streak} liên tiếp` : '';
            return `${emoji} ${a.ticker}: ${label} ${side === 'buy' ? 'MUA' : 'BÁN'} ròng ${fmtVnd(Math.abs(latest.netValue))}đ phiên ${latest.date}${streakTxt}.`;
        }
        if (a.alertType === 'insider') {
            const txs = await cafefService.getInsiderTransactions(a.ticker, 10);
            if (txs.length === 0) return null;
            const lastSeen = Number(a.params?.lastSeen ?? 0);
            const fresh = txs.filter((t) => t.publishedMs > lastSeen);
            if (fresh.length === 0) return null;
            // Advance the marker so the same filing won't re-fire next session.
            const newest = Math.max(...txs.map((t) => t.publishedMs));
            await alertService.setParams(a.id, { ...(a.params || {}), lastSeen: newest });
            const lines = fresh.slice(0, 3).map(formatInsiderTx).join('\n\n');
            const more = fresh.length > 3 ? `\n\n(+${fresh.length - 3} đăng ký mới khác)` : '';
            return `👔 ${a.ticker}: có ${fresh.length} đăng ký giao dịch nội bộ MỚI\n\n${lines}${more}`;
        }
        if (a.alertType === 'volume') {
            const bars = await vnStockService.getDailyBars(a.ticker, 25);
            if (bars.length < 21) return null;
            const today = bars[bars.length - 1];
            const prior = bars.slice(-21, -1).map((b) => b.v);
            const avg = sma(prior, 20);
            if (avg === null || avg <= 0) return null;
            const mult = today.v / avg;
            if (mult < a.targetPrice) return null;
            return `🔔 ${a.ticker}: volume phiên gần nhất gấp ${mult.toFixed(1)}x trung bình 20 phiên (ngưỡng ${a.targetPrice}x).`;
        }
        if (a.alertType === 'rsi') {
            const bars = await vnStockService.getDailyBars(a.ticker, 40);
            const rsi = computeRSI(bars.map((b) => b.c), 14);
            if (rsi === null) return null;
            const hit = a.condition === 'above' ? rsi >= a.targetPrice : rsi <= a.targetPrice;
            if (!hit) return null;
            return `🔔 ${a.ticker}: RSI(14) = ${rsi.toFixed(1)} (${a.condition === 'above' ? '≥' : '≤'} ${a.targetPrice}).`;
        }
        if (a.alertType === 'macross') {
            const bars = await vnStockService.getDailyBars(a.ticker, 60);
            const closes = bars.map((b) => b.c);
            const ma20 = sma(closes, 20);
            const ma50 = sma(closes, 50);
            const ma20p = sma(closes.slice(0, -1), 20);
            const ma50p = sma(closes.slice(0, -1), 50);
            if (ma20 === null || ma50 === null || ma20p === null || ma50p === null) return null;
            const golden = ma20p <= ma50p && ma20 > ma50;
            const death = ma20p >= ma50p && ma20 < ma50;
            if (!golden && !death) return null;
            return `🔔 ${a.ticker}: ${golden ? 'GOLDEN CROSS 🟢 (MA20 cắt lên MA50)' : 'DEATH CROSS 🔴 (MA20 cắt xuống MA50)'}.`;
        }
    } catch (e) {
        console.error(`[VnAlerts] evaluate failed for ${a.ticker} (${a.alertType}):`, e);
    }
    return null;
}

// --- VN EOD ALERT CRON (15:15 ICT, weekdays — after HOSE/HNX close) ---
let vnAlertCronBusy = false;
cron.schedule('15 15 * * 1-5', async () => {
    if (vnAlertCronBusy) return;
    vnAlertCronBusy = true;
    console.log('[VnAlerts] Running EOD VN alert cron...');
    try {
        const active = (await alertService.getAllActive()).filter((a) => a.alertType !== 'price');
        for (const a of active) {
            const msg = await evaluateEodAlert(a);
            if (!msg) continue;
            // One-shot alerts: mark triggered BEFORE sending so a send failure can't re-fire
            // forever. Recurring money-flow alerts stay active and re-evaluate every session
            // (cron runs once/day → no same-day double fire).
            if (a.params?.recurring !== true) await alertService.markTriggered(a.id);
            try {
                await bot.api.sendMessage(a.userId, msg);
            } catch (e) {
                console.error(`[VnAlerts] send failed for user ${a.userId}:`, e);
            }
            await new Promise((r) => setTimeout(r, 150)); // Telegram rate-limit cushion
        }
    } catch (e) {
        console.error('[VnAlerts] cron error:', e);
    } finally {
        vnAlertCronBusy = false;
    }
}, {
    timezone: 'Asia/Ho_Chi_Minh',
});

// --- DAILY SMART-MONEY DIGEST CRON (15:30 ICT, weekdays — after VN close) ---
// For each Pro+ user, ranks the latest-session foreign + proprietary net flow across the
// VN tickers they actually track (watchlist ∪ portfolio ∪ active alerts) and DMs the top
// money movers. Personalised → a reason to open the app every session.

// Union of the VN tickers a user is tracking, across watchlist, portfolio and alerts.
async function trackedVnTickers(userId: number): Promise<string[]> {
    const [wl, positions, userAlerts] = await Promise.all([
        watchlistService.getWatchlist(userId),
        portfolioService.getPositions(userId),
        alertService.getActiveAlerts(userId),
    ]);
    const set = new Set<string>();
    for (const t of wl) set.add(t.toUpperCase());
    for (const p of positions) set.add(p.ticker.toUpperCase());
    for (const a of userAlerts) set.add(a.ticker.toUpperCase());
    return [...set].filter((t) => marketRouter.classify(t) === 'vn');
}

interface FlowRow { ticker: string; foreign?: number; prop?: number; }

// Render the smart-money digest, or null if there's no usable flow data.
function buildSmartMoneyDigest(rows: FlowRow[]): string | null {
    const fmtLine = (t: string, v: number) => `${v >= 0 ? '🟢' : '🔴'} ${t}: ${v >= 0 ? '+' : '-'}${fmtVnd(Math.abs(v))}đ`;
    const section = (title: string, pick: (r: FlowRow) => number | undefined): string | null => {
        const vals = rows
            .map((r) => ({ ticker: r.ticker, v: pick(r) }))
            .filter((x): x is { ticker: string; v: number } => Number.isFinite(x.v))
            .sort((a, b) => b.v - a.v);
        if (vals.length === 0) return null;
        const buys = vals.filter((x) => x.v > 0).slice(0, 5);
        const sells = vals.filter((x) => x.v < 0).slice(-3).reverse(); // 3 most-negative, biggest first
        const lines = [...buys, ...sells].map((x) => fmtLine(x.ticker, x.v));
        return lines.length ? `${title}\n${lines.join('\n')}` : null;
    };
    const sections = [
        section('🌐 Khối ngoại (ròng):', (r) => r.foreign),
        section('🏦 Tự doanh CTCK (ròng):', (r) => r.prop),
    ].filter((s): s is string => s !== null);
    if (sections.length === 0) return null;
    return `💰 Dòng tiền lớn cuối phiên — mã bạn theo dõi\n\n${sections.join('\n\n')}\n\n— 🤖 EdgeBook · t.me/${bot.botInfo.username}`;
}

let smartMoneyCronBusy = false;
cron.schedule('30 15 * * 1-5', async () => {
    if (smartMoneyCronBusy) return;
    smartMoneyCronBusy = true;
    console.log('[SmartMoney] Running daily smart-money digest cron...');
    try {
        const users = await planService.getDigestEligibleUsers();
        for (const userId of users) {
            try {
                const tickers = (await trackedVnTickers(userId)).slice(0, 30);
                if (tickers.length === 0) continue;
                const rows: FlowRow[] = await Promise.all(
                    tickers.map(async (ticker) => {
                        const [fo, pr] = await Promise.all([
                            cafefService.getForeignSeries(ticker, 1),
                            cafefService.getProprietarySeries(ticker, 1),
                        ]);
                        return { ticker, foreign: fo[0]?.netValue, prop: pr[0]?.netValue };
                    })
                );
                const msg = buildSmartMoneyDigest(rows);
                if (!msg) continue;
                await bot.api.sendMessage(userId, msg);
                await new Promise((r) => setTimeout(r, 150)); // Telegram rate-limit cushion
            } catch (e) {
                console.error(`[SmartMoney] Error for user ${userId}:`, e);
            }
        }
    } catch (e) {
        console.error('[SmartMoney] cron error:', e);
    } finally {
        smartMoneyCronBusy = false;
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

// Send a SePay VietQR code for direct bank-transfer payment (VN users)
async function sendSepayQuote(ctx: Context, userId: number, tier: 'pro' | 'premium' | 'trial'): Promise<void> {
    const { qrUrl, amount, content } = sepayService.generateQuote(userId, tier);
    const tierLabel = tier === 'pro' ? '⭐ Pro' : tier === 'premium' ? '💎 Premium' : '🎁 Trial Pro 7 ngày';
    const trailer = tier === 'trial'
        ? `Quét mã hoặc chuyển khoản đúng nội dung và số tiền trên. Hệ thống tự kích hoạt Trial Pro 7 ngày trong vài giây.\n\n⚠️ Trial chỉ mua được 1 lần. Hết 7 ngày tự về Free, không tự động gia hạn hay trừ tiền thêm.`
        : `Quét mã hoặc chuyển khoản đúng nội dung và số tiền trên. Hệ thống tự nhận diện và nâng cấp plan trong vài giây, không cần làm gì thêm.`;

    await ctx.replyWithPhoto(qrUrl, {
        caption:
            `${tierLabel} — Chuyển khoản VietQR\n\n` +
            `Số tiền: ${amount.toLocaleString('vi-VN')}đ\n` +
            `Nội dung CK: ${content}\n\n` +
            trailer,
    });
}

// Handle upgrade inline keyboard callbacks
bot.callbackQuery('upgrade_pro', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    await sendSepayQuote(ctx, userId, 'pro');
});

bot.callbackQuery('upgrade_premium', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    await sendSepayQuote(ctx, userId, 'premium');
});

bot.callbackQuery('upgrade_trial', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    // Re-check ngay tại callback time để chặn race: user mở 2 chat /upgrade,
    // mua trial ở chat A, rồi bấm Trial ở chat B — UI cũ vẫn còn nút.
    if (await planService.hasUsedTrial(userId)) {
        await ctx.reply('⚠️ Bạn đã dùng gói Trial trước đó. Vui lòng chọn Pro (99k) hoặc Premium (199k) qua /upgrade.');
        return;
    }
    await sendSepayQuote(ctx, userId, 'trial');
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

// --- CONNECT DOCS CALLBACKS (from the count-based nag) ---
bot.callbackQuery('connectdocs', async (ctx) => {
    const userId = ctx.from?.id;
    await ctx.answerCallbackQuery();
    if (!userId) return;
    try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch { /* message may be too old to edit */ }
    await sendConnectDocsInstructions(ctx, userId);
});

bot.callbackQuery('connectdocs:skip', async (ctx) => {
    const userId = ctx.from?.id;
    await ctx.answerCallbackQuery({ text: '👍 Sẽ không nhắc lại.' });
    if (!userId) return;
    await userService.dismissDocsHint(userId);
    try {
        await ctx.editMessageText('👍 OK, dùng Telegram là đủ. (Vẫn có thể gõ Connect Docs sau này.)');
    } catch { /* edit failed, no-op */ }
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
startWebhookServer(sepayService, bot, oauthService);

// Start the bot
bot.start({
    onStart: async (botInfo) => {
        console.log(`EdgeBook bot @${botInfo.username} started!`);
        console.log('EdgeBook features enabled: auto-tag, search, digest, star, stats, trade journal');
        console.log('Payment: SePay VietQR ' + (sepayService.isConfigured() ? 'enabled' : '(⚠️ SEPAY_* not set)'));
        try {
            await bot.api.setMyCommands(BOT_COMMANDS);
            console.log(`Registered ${BOT_COMMANDS.length} bot commands in the "/" menu.`);
        } catch (e) {
            console.error('Failed to register bot commands:', e);
        }
    },
});
