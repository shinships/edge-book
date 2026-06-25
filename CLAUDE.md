# CLAUDE.md — Project Guide for AI Assistants

> **Brand: EdgeBook** — *"capture your edge."* A trading research OS that lives in Telegram.
> (Formerly "Bot Forward Docs"; npm package `edgebook`.)

> **Quy ước giao tiếp với user:** Luôn trả lời **ngắn gọn, súc tích, bằng tiếng Việt**. Đi thẳng vào kết quả, không dài dòng.

## Project Overview

**EdgeBook** is a **Telegram Bot** that acts as a personal AI assistant and **Research OS for traders/investors**. Integrates **AI chat via Vertex-Key.com** (OpenAI-compatible API), **Google Docs** for saving notes/images, **Google Calendar** for scheduling, a **To-Do list**, a **smart research management system** (auto-tagging, search, digest), a **Trade Journal** with PDF export, **price alerts & watchlist** (live Binance prices), and subscription tiers. Built with **TypeScript**, uses the **grammY** framework for Telegram Bot API; data lives in **PostgreSQL (Supabase)** via **Drizzle ORM**.

## Tech Stack

| Layer        | Technology                                    |
| ------------ | --------------------------------------------- |
| Runtime      | Node.js + TypeScript (ES2022, CommonJS)       |
| Bot Framework| grammY v1.20                                  |
| AI           | Vertex-Key.com (`openai` SDK) via OpenAI-compatible API — chat `AI_CHAT_MODEL` (default `aws/claude-sonnet-4-6-medium`), fast `AI_FAST_MODEL` (default `free/claude-haiku-4-5`) |
| Database     | **PostgreSQL (Supabase)** via **Drizzle ORM** (`drizzle-orm` + `postgres` driver); schema in `src/db/schema.ts`, migrations via `drizzle-kit` |
| Google APIs  | `googleapis` (Calendar v3, Drive v3, Docs v1) |
| Market data  | Crypto: Binance public REST API (`market.service.ts`). VN stocks: VNDirect public API (`vn-stock.service.ts`) — dchart-api for price/bars, finfo-api for foreign flow + fundamentals. Routed per-ticker by `market-router.ts`. No keys. |
| PDF          | `pdfkit` — trade report export (ASCII/English text; built-in fonts can't render VN diacritics) |
| Auth         | Google Service Account (`service_account.json`) |
| Config       | `dotenv` (`.env` file)                        |
| Dev          | `nodemon` + `ts-node` for hot-reload          |

## Directory Structure

```
edge-book/
├── .env                        # Secrets — NEVER commit
├── service_account.json        # Google SA key — NEVER commit
├── package.json
├── tsconfig.json
├── nodemon.json
├── PLAN.md                     # Product & monetization roadmap
├── GTM.md                      # Growth marketing & viral playbook
├── AGENTS.md                   # Codex (reviewer agent) instructions
├── drizzle.config.ts           # drizzle-kit config (schema path, DATABASE_URL)
├── service-entry.js            # Stable launcher for the Windows Service (requires ./dist/index.js)
├── scripts/
│   ├── service-install.js      # Install + start the "EdgeBookBot" Windows Service (elevated)
│   └── service-uninstall.js    # Stop + remove the service (elevated)
├── daemon/                     # node-windows winsw exe/config/logs (gitignored, created on install)
├── data/                       # LEGACY JSON files (users/todos/research/plans/trades/theses) —
│                               # only used as seed source for `npm run db:seed`; runtime is on Postgres
├── src/
│   ├── config.ts               # Loads env vars, validates required keys
│   ├── index.ts                # Entry point — bot commands, message handlers, cron jobs
│   ├── webhook.server.ts       # Express HTTP server for payment webhooks (LemonSqueezy + SePay)
│   ├── db/
│   │   ├── index.ts            # postgres client + drizzle instance (exits if DATABASE_URL missing)
│   │   └── schema.ts           # Drizzle schema: users, plans, research_items, trades, theses, alerts, watchlist_items, portfolio_positions, discipline_state, referrals, todos
│   ├── scripts/
│   │   └── migrate-json-to-db.ts # One-time seed: legacy data/*.json → Postgres (`npm run db:seed`)
│   ├── services/
│   │   ├── ai.service.ts       # AI chat, calendar analysis, digest generation, research Q&A
│   │   ├── alert.service.ts    # Price alerts CRUD (active/triggered) — checked by per-minute cron
│   │   ├── discipline.service.ts # Discipline mode: loss streak, daily loss limit, cooldown (Sprint 9)
│   │   ├── google.service.ts   # Calendar, Drive, Docs API wrappers
│   │   ├── market.service.ts   # Binance public API: batch prices + 24h stats, 45s cache, never throws
│   │   ├── vn-stock.service.ts # VNDirect public API: VN stock price/bars (dchart) + foreign flow & fundamentals (finfo); cached, never throws
│   │   ├── market-router.ts    # Routes each ticker to crypto (Binance) or VN (VNDirect) and merges results behind getPrices/get24hStats
│   │   ├── payment.service.ts  # LemonSqueezy checkout creation, HMAC verify, upgrade logic
│   │   ├── plan.service.ts     # Subscription tier tracking & feature gating
│   │   ├── portfolio.service.ts # Portfolio position ledger: buy/avg-in, sell+realized PnL, live valuation (Pro+)
│   │   ├── report.service.ts   # PDF trade report generation via pdfkit (Premium export)
│   │   ├── research.service.ts # Research items: auto-tagging, search, star, digest data
│   │   ├── sepay.service.ts    # SePay VietQR bank-transfer: QR generation, webhook auth/parse, upgrade logic (Sprint 10)
│   │   ├── thesis.service.ts   # Thesis tracker: record theses + conflict detection vs research sentiment (Premium)
│   │   ├── todo.service.ts     # To-do CRUD per user
│   │   ├── trade.service.ts    # Trade Journal: open/close trades, PnL calc, stats, analytics (Pro/Premium)
│   │   ├── user.service.ts     # User profile management & doc aliases
│   │   └── watchlist.service.ts # Watchlist CRUD (unique user+ticker)
│   ├── test-ai.ts              # Manual test: verify Vertex-Key API connection
│   ├── test-calendar.ts        # Manual test: create calendar event
│   └── test-drive.ts           # Manual test: upload file to Drive
└── dist/                       # Compiled JS output (gitignored)
```

## Commands

```bash
# Install dependencies
npm install

# Development (hot-reload via nodemon + ts-node)
npm run dev

# Build TypeScript → dist/
npm run build

# Production
npm start

# Database (Drizzle ORM ↔ Supabase Postgres)
npm run db:push      # push schema thẳng lên DB (dev) — ⚠️ dùng session pooler port 5432, xem chú ý dưới
npm run db:generate  # generate SQL migration files
npm run db:migrate   # apply migrations
npm run db:seed      # one-time seed: legacy data/*.json → Postgres

# Manual tests
npx ts-node src/test-ai.ts
npx ts-node src/test-calendar.ts
npx ts-node src/test-drive.ts

# Windows Service (run in background + on boot) — run from an ELEVATED shell
npm run build              # ensure dist/ is fresh first
npm run service:install    # install + start the "EdgeBookBot" service
npm run service:uninstall  # stop + remove the service
```

### Running as a Windows Service

EdgeBook can run as a background Windows service (auto-start on boot, auto-restart on crash) via **`node-windows`** (winsw under the hood).

- **Scripts**: `scripts/service-install.js` / `scripts/service-uninstall.js`, exposed as `npm run service:install` / `service:uninstall`. Service name: **`EdgeBookBot`**.
- **Stable launcher**: the service points at `service-entry.js` (project root), which just `require('./dist/index.js')`. This keeps the generated `daemon/` folder (winsw exe + config + logs, gitignored) at the project root instead of inside the rebuildable `dist/`.
- **Working directory** is set to the project root so `.env` (dotenv) and `GOOGLE_APPLICATION_CREDENTIALS=./service_account.json` resolve correctly.
- **Requires Administrator**: installing/removing a Windows service needs an elevated shell — `npm run service:install` from a non-admin terminal fails.
- **⚠️ One instance only**: Telegram long-polling allows a single `getUpdates` consumer. Before installing/starting the service, stop any manually-run bot (`npm start` / `npm run dev`) or Telegram returns 409 Conflict. Likewise, don't `npm start` while the service is running.
- **Manage**: `services.msc`, or `sc start EdgeBookBot.exe` / `sc stop EdgeBookBot.exe`. Logs land in `daemon/EdgeBookBot.out.log` / `.err.log`.

## Environment Variables (`.env`)

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | ✅       | Telegram Bot API token                   |
| `VERTEX_KEY_API_KEY`          | ✅       | API key from vertex-key.com              |
| `VERTEX_KEY_BASE_URL`         | Optional | API base URL (default: `https://vertex-key.com/api/v1`) |
| `AI_CHAT_MODEL`               | Optional | Chat model ID (default: `aws/claude-sonnet-4-6-medium`) |
| `AI_FAST_MODEL`               | Optional | Fast model ID (default: `free/claude-haiku-4-5`) |
| `DATABASE_URL`                | ✅       | Postgres connection string (Supabase) — app exits on startup if missing (`src/db/index.ts`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | ✅    | Path to Service Account JSON file        |
| `GOOGLE_DOC_ID`               | Optional | Default Google Doc ID for saving content |
| `GOOGLE_DRIVE_FOLDER_ID`      | Optional | Drive folder for photo uploads           |
| `LEMONSQUEEZY_API_KEY`        | Optional | LS API key — required to enable `/upgrade` |
| `LEMONSQUEEZY_STORE_ID`       | Optional | LS Store ID                              |
| `LEMONSQUEEZY_PRO_VARIANT_ID` | Optional | LS Variant ID for Pro plan               |
| `LEMONSQUEEZY_PREMIUM_VARIANT_ID` | Optional | LS Variant ID for Premium plan       |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Optional | Webhook signing secret for HMAC verify   |
| `WEBHOOK_PORT`                | Optional | Port for webhook Express server (default: `3000`) |
| `SEPAY_ACCOUNT_NUMBER`        | Optional | Bank account number receiving transfers — required to enable VietQR in `/upgrade` |
| `SEPAY_BANK_CODE`             | Optional | SePay bank short code (e.g. `MBBank`, `Vietcombank`) for VietQR generation |
| `SEPAY_ACCOUNT_HOLDER`        | Optional | Account holder name shown on the generated QR |
| `SEPAY_API_KEY`               | Optional | SePay webhook API key, verified as `Authorization: Apikey <key>` |
| `SEPAY_PRO_PRICE_VND`         | Optional | Pro price in VND (default `199000`)      |
| `SEPAY_PREMIUM_PRICE_VND`     | Optional | Premium price in VND (default `499000`)  |
| `ADMIN_USER_IDS`              | Optional | Comma-separated Telegram user IDs treated as admins (always Premium access) |

`TELEGRAM_BOT_TOKEN`, `VERTEX_KEY_API_KEY` (in `config.ts`) and `DATABASE_URL` (in `src/db/index.ts`) are validated on startup — app exits if missing.
LemonSqueezy keys are optional; if absent, the international-card option is hidden from `/upgrade`. SePay keys are optional; if absent, the VietQR option is hidden. If neither is configured, `/upgrade` shows a "not configured" message.

> ⚠️ **Supabase pooler gotcha:** runtime dùng transaction pooler (port **6543**) là OK, nhưng `npm run db:push` với drizzle-kit sẽ **treo ở "Pulling schema"** trên pooler này. Khi đổi schema: tạm sửa `DATABASE_URL` trong `.env` sang **session pooler port 5432**, chạy `db:push`, rồi đổi lại.

## Architecture & Key Patterns

### Message Flow (index.ts)

All logic is in `bot.on('message:text')` and `bot.on('message:photo')` handlers in `index.ts`. Message routing uses **regex matching + keyword detection** in this priority order:

1. **Doc management**: `Add Doc <alias> <id>`, `Use Doc <alias>`, `Current Doc` (replies with the active doc's alias + ID + a clickable `docs.google.com` link; falls back to `GOOGLE_DOC_ID` default)
2. **To-Do List**: Quick task management via `Add Task: [content]` and `List Tasks`.
3. **Research OS commands** (new):
   - `Search: <keyword>` — full-text search in saved research (Pro)
   - `Tag: <ticker>` — filter by ticker symbol (Pro)
   - `Digest` / `Daily Digest` — AI-generated daily summary (Pro)
   - `Weekly Report` / `Weekly` — 7-day report: top tickers, per-ticker sentiment shift vs last week, key insights (Pro)
   - `Stats` — research statistics and top tickers
   - `Starred` / `Bookmarks` — view bookmarked items
   - `Star` / `⭐` — bookmark the most recent research item
   - `Ask: <question>` — AI answers questions about your saved research (Pro)
   - `Thesis: <ticker> <bullish|bearish> <text>` — record a thesis (Premium); the bot alerts when newly-saved research contradicts it (rule-based sentiment vs stance, 0.2 threshold)
   - `Theses` / `My Theses` — list active theses (shows ⚠️N conflict count); `Close Thesis: <index|ticker>` — close one
   - `/plan` / `My Plan` — view current subscription plan and limits
4. **Trade Journal commands** (Pro):
   - `Trade: <Long|Short> <ticker> entry <price> SL <price> TP <price>` — open a trade (regex-parsed, `k` suffix supported). Optional extras (Trade Journal 2.0): `size 500 risk 1% fee 0.1% setup breakout` → `positionSize`, `riskPercent`, `feePercent`, `setupTag`
   - `Close: <ticker> <price>` or `Close: <ticker> +3.2%` — close most-recent open trade, auto-computes PnL% (shows net-after-fee if `feePercent` set). Optional `sl`/`tp` suffix (e.g. `Close: BTC 105k sl`) records `closeReason` ('tp' | 'sl' | 'manual')
   - `Trades` / `My Trades` — list open + recent closed trades (shows 🔗N link tag, #setupTag)
   - `Trade Stats` — win rate, total PnL, avg planned RR, best/worst
   - `Trade Analytics` / `Performance` (Premium) — breakdown by ticker/direction/month + avg hold + R-multiple + AI insight
   - `Export` / `Export PDF` (Premium) — generates a PDF trade report (summary, monthly bar chart, ticker/direction breakdown, trade log) via `ReportService` and sends it as a Telegram document
5. **Market & Alerts commands** (Sprint 8):
   - `Watch: <ticker>` / `Unwatch: <ticker>` — add/remove ticker (free tối đa 3, Pro+ unlimited)
   - `Watchlist` — live price + 24h change per ticker (Binance via `MarketService`)
   - `Alert: <ticker> > <price>` / `Alert: <ticker> < <price>` — price alert (Pro: max 10 active, Premium: unlimited; `k` suffix supported)
   - `Alerts` / `My Alerts` — list active alerts with inline delete buttons (callback `alertdel:<id>`)
6. **Discipline & Psychology commands** (Sprint 9, Pro — đi cùng `canTrade`):
   - **15s safety gate** (mặc định BẬT): `Trade:` không mở lệnh ngay — bot stash params vào `pendingTrades` Map (in-memory) và gửi checklist 3 câu (callback `dchk:<i>`) + nút Vào lệnh (`dgo`, chỉ pass khi tick đủ 3 + đã qua 15s; TTL 10 phút) + Huỷ (`dcancel`)
   - `Trade:` nhận thêm token `emo <1-10>` (emotion score) và `hr <bpm>` (heart rate); thiếu `emo` → bot gửi keyboard 1-10 sau khi mở lệnh (callback `emo:<tradeId>:<n>` / `emoskip:`); `emo ≥ 8` hoặc `hr ≥ 110` → cảnh báo cortisol/adrenaline, khuyên rời màn hình
   - `Close:` lệnh lỗ → streak +1, nhắc giảm 50% risk (tính sẵn con số từ `riskPercent`/`positionSize`); đủ `dailyLossLimit` lệnh thua/ngày (mặc định 3) → khoá `Trade:` tới hết ngày VN; đồng thời hỏi "có tuân thủ kế hoạch không?" (callback `audit:<tradeId>:<1|0>`) → phản hồi vị tha nếu Có, không phán xét nếu Không
   - `Discipline` (status) / `Discipline On` / `Discipline Off` · `Limit: <1-10>` (giới hạn thua/ngày) · `Review`/`Audit` (đối soát chủ động các lệnh đóng hôm nay)
7. **Calendar**: Messages containing "schedule", "meeting", or "remind" → AI extracts event data → Calendar API
8. **Personalization**: `Call me <name>`, `My name is <name>`, `My job is <job>`, `Remember: <note>`
9. **Save to Docs + Research**: `Save: <content>` command OR forwarded messages → auto-tags tickers, classifies category, scores sentiment, saves to Research DB + appends to active Google Doc. For Premium users, also runs `ThesisService.findConflicts()` and sends a conflict alert if the new item contradicts an active thesis.
10. **Default**: Falls through to AI chat with per-user session

### Photo Handler

Photos are saved to Google Docs when:
- Caption contains "save" keyword, OR
- Message is forwarded from another chat

Reacts with ❤ emoji on success (falls back to text reply if reactions aren't supported).

### Service Layer

- **AIService**: Uses OpenAI SDK (`openai` package) with Vertex-Key.com as base URL. Manages per-user conversation history (messages array) with personalized system instructions. History is in-memory (Map, max 50 messages), not persisted. Post-processes responses to strip markdown formatting (bold, headers) and escape underscores. Also provides `generateDigest()`, `generateWeeklyReport()` (top tickers + sentiment shift) and `askAboutResearch()` for the Research OS, plus `generateTradeInsight()` for trade analytics.
- **GoogleService**: Thin wrappers around Google APIs. Uses Service Account auth. Calendar defaults to `Asia/Ho_Chi_Minh` timezone.
- **ResearchService**: Persists to Postgres (`research_items`) via Drizzle. Manages research items with auto-tagging (tickers via regex), category classification (keyword-based), sentiment scoring (rule-based), search (by keyword/ticker/category), star/bookmark, digest data aggregation, and weekly-report data (`getWeeklyReportData` — this-week vs last-week activity + per-ticker sentiment shift).
- **PlanService**: Persists to Postgres (`plans`). Manages subscription tiers (free/pro/premium), daily forward rate limiting, feature gating, plan expiration, and `digestEnabled` toggle. Accepts an admin-ID list (from `config.adminUserIds` / `ADMIN_USER_IDS`); admins are always treated as Premium (`isAdmin()`, `effectiveTier()` → all feature gates pass, unlimited forwards, always digest-eligible). `PlanLimits` now includes `maxWatchlist` (free 3, Pro+ -1) and `maxActiveAlerts` (free 0 = locked, Pro 10, Premium -1).
- **UserService**: Persists to Postgres (`users`). Supports multi-doc aliases (e.g., `work` → `<docId>`). Auto-sets first added doc as active.
- **TodoService**: Persists to Postgres (`todos`). Supports completion by index (1-based) or keyword search.
- **TradeService**: Persists to Postgres (`trades`). Manages the Trade Journal — open/close trades, auto-computes PnL% (price- or percent-based, direction-aware), and aggregates stats (win rate, total PnL, avg planned RR, best/worst). Pro-gated via `canTrade`. Trade Journal 2.0 fields: `positionSize`, `riskPercent`, `feePercent` (net PnL after fee), `setupTag`, `closeReason` ('tp'|'sl'|'manual'), plus `actualR()` (R-multiple). Also supports **research-to-trade link** (`linkResearch`/`getTradeById`, `linkedResearch: string[]` on each trade) — Premium-gated via `canLinkResearch`. On `Close:`, Premium users get an inline keyboard of recent research matching the ticker (callback `linkres:<tradeId>:<researchId>`); the `Trades` list shows a 🔗N tag for trades with links. Also provides **advanced analytics** (`getAnalytics` → breakdown by ticker/direction/month + avg hold duration over closed trades) — Premium-gated via `canAnalytics`, surfaced by the `Trade Analytics` command with an AI insight from `AIService.generateTradeInsight`.
- **ThesisService**: Persists to Postgres (`theses`). Records per-user theses (`ticker`, `stance` bullish/bearish, `text`) and detects contradictions: `findConflicts(userId, ticker, sentiment)` returns active theses whose stance is clearly opposed to a newly-saved research item's sentiment (±0.2 threshold) and bumps their `conflictCount`. Wired into the Save/forward flow in `index.ts`; Premium-gated via `canThesis`. Detection is rule-based (no AI call on the save hot path).
- **AlertService** *(new, Sprint 8)*: Persists to Postgres (`alerts`). Price alert CRUD — `addAlert` (above/below + target), `getActiveAlerts`, `getAllActive` (for the cron), `deleteAlert`, `markTriggered`. Gated by `PlanLimits.maxActiveAlerts`.
- **WatchlistService** *(new, Sprint 8)*: Persists to Postgres (`watchlist_items`, unique index user+ticker). `add` (onConflictDoNothing → 'added'|'exists'), `remove`, `getWatchlist`. Gated by `PlanLimits.maxWatchlist`.
- **MarketService** *(new, Sprint 8)*: **No DB** — live crypto prices from Binance public REST API (no key). `getPrices()` (batch, used by per-minute alert cron) and `get24hStats()` (Watchlist). Maps ticker → `<BASE>USDT` symbol, 45s in-memory cache with negative-caching, 8s timeout, batch endpoint with per-symbol fallback. Best-effort: never throws, returns partial/empty maps on failure.
- **DisciplineService** *(new, Sprint 9)*: Persists to Postgres (`discipline_state`, 1 row/user, auto-created with defaults: enabled, limit 3). Tracks loss streak (`recordLoss`/`recordWin`), daily loss counter (VN-timezone date string, lazy reset on read), `dailyLossLimit`, and `cooldownUntil` (set to end of VN day when the limit is hit). The 15s safety gate itself is in-memory in `index.ts` (`pendingTrades` Map), not in this service. Trade journal psychology fields (`emotionScore`, `heartRate`, `disciplined`) live on `trades` and are managed by `TradeService.setEmotion`/`setDisciplined`; `getStats()` exposes `disciplinedPnl` (PnL minus undisciplined "lucky" wins), `disciplineRate`, and `getAnalytics()` adds `byEmotion` (calm ≤5 vs stressed ≥7, requires ≥3 scored trades).
- **ReportService** *(new)*: Generates a trade performance **PDF** with `pdfkit` (in-memory `Buffer`, sent via grammY `InputFile`). Renders a header banner, summary, a drawn monthly-PnL bar chart, by-ticker/by-direction tables, and a closed-trade log with multi-page support (`bufferPages: true` for the footer pass). PDF text is **ASCII/English** — pdfkit's built-in fonts can't render Vietnamese diacritics, so `index.ts` runs the trader name through a `toAscii()` helper. Premium-gated via `canExport`.
- **PaymentService**: LemonSqueezy checkout — `createCheckoutLink(userId, tier)` passes `user_id`/`tier` as `custom_data` so the webhook can identify the buyer; `verifyWebhookSignature()` (HMAC-SHA256 over the raw body); `handleWebhookEvent()` validates `order_created`/`paid`, checks `plans.lsOrderId` for idempotency, then `planService.upgradePlan(userId, tier, 30, orderId)`.
- **SepayService** *(new, Sprint 10)*: VietQR bank-transfer payment for VN users — **no pending-order table**. `generateQuote(userId, tier)` builds a `qr.sepay.vn/img` URL with a payment content string `EBOOK<userId><PRO|PRE>` encoding the buyer + tier directly, plus the VND amount (`SEPAY_PRO_PRICE_VND`/`SEPAY_PREMIUM_PRICE_VND`). `verifyAuth()` checks the `Authorization: Apikey <SEPAY_API_KEY>` header SePay sends with each webhook. `handleWebhookEvent()` parses that content back out of the transaction `content`/`description`, checks `transferAmount` against the expected price, dedupes via `plans.sepayTxId` (unique), then `planService.upgradePlan(userId, tier, 30, undefined, txId)`.

### Subscription Tiers

| Feature | Free | Pro ($9.99/mo) | Premium ($24.99/mo) |
|---|---|---|---|
| Forwards/day | 10 | Unlimited | Unlimited |
| Search & Tag | ❌ | ✅ | ✅ |
| Daily Digest | ❌ | ✅ | ✅ |
| Trade Journal | ❌ | ✅ | ✅ |
| Research↔Trade link | ❌ | ❌ | ✅ |
| Perf Analytics | ❌ | ❌ | ✅ |
| Weekly Report | ❌ | ✅ | ✅ |
| Thesis Tracker | ❌ | ❌ | ✅ |
| Star/Bookmark | ✅ | ✅ | ✅ |
| Sentiment | ❌ | ❌ | ✅ |
| Export | ❌ | ❌ | ✅ |
| Watchlist | 3 tickers | Unlimited | Unlimited |
| Price Alerts | ❌ | 10 active | Unlimited |
| VN Alerts (foreign/volume/RSI/MA) | ❌ | ✅ | ✅ |
| Portfolio (danh mục) | ❌ | ✅ | ✅ |
| Max Docs | 1 | 5 | Unlimited |

> **Admin override:** Telegram user IDs in `ADMIN_USER_IDS` (`.env`) are always treated as **Premium** regardless of stored plan — every gate passes, unlimited forwards, always digest-eligible. See `PlanService.isAdmin()` / `effectiveTier()`.

### Cron Jobs

**Daily Digest** — a `node-cron` job runs at **08:00 daily (Asia/Ho_Chi_Minh)** that:
1. Gathers research items from the last 24 hours per user
2. Groups by ticker, calculates sentiment
3. Generates AI-powered summary via `AIService.generateDigest()`
4. Sends formatted digest to every user who has research items in that window (Pro/Premium users are always included; free users are included if they have research)
5. Checks and downgrades expired subscription plans

**Weekly Report** — a `node-cron` job runs at **18:00 every Sunday (Asia/Ho_Chi_Minh)** that, for each digest-eligible (Pro/Premium) user with research in the last 7 days, builds `getWeeklyReportData()` and sends an AI report (`AIService.generateWeeklyReport()`) highlighting per-ticker sentiment shift vs the previous week.

**Price Alert Checker** — a `node-cron` job runs **every minute** (`* * * * *`): loads all active alerts (`AlertService.getAllActive()`), batch-fetches prices via `MarketService.getPrices()`, marks hit alerts as triggered, and DMs the owner. Guarded by an in-flight flag (`alertCronBusy`) so overlapping runs are skipped.

**EOD Process Audit** — a `node-cron` job runs at **21:00 daily (Asia/Ho_Chi_Minh)**: for each user with trades (`TradeService.getAllUserIds()`) who is Pro+ and has discipline mode enabled, sends up to 5 unaudited trades closed today (`getUnauditedClosedToday()`) with ✅/❌ process-audit buttons (callback `audit:<tradeId>:<1|0>`) — the "perfect trader" ledger.

### Data Persistence

All data lives in **PostgreSQL (Supabase)** via **Drizzle ORM** — schema in `src/db/schema.ts` (`users`, `plans`, `research_items`, `trades`, `theses`, `alerts`, `watchlist_items`, `portfolio_positions`, `discipline_state`, `referrals`, `todos`), connection in `src/db/index.ts` (`postgres` driver + `DATABASE_URL`). All service methods are **async**.

- Legacy JSON files in `data/` are no longer read at runtime — they were the pre-Sprint-7 store and remain only as the seed source for `npm run db:seed` (`src/scripts/migrate-json-to-db.ts`).
- DB migration removed the old "single instance for data safety" constraint; the remaining single-instance limit is Telegram long-polling (one `getUpdates` consumer, see Windows Service section).

## Important Conventions

### Git Workflow

**Dự án solo — KHÔNG tạo Pull Request. Không gợi ý tạo PR.**
- Commit thẳng lên `main` cho các thay đổi nhỏ.
- Dùng feature branch (e.g., `sprint-2a-payment`) khi làm sprint lớn, sau đó **merge trực tiếp** vào `main` sau khi build pass — không qua PR.
- Không cần code review hay PR approval. Không chạy `gh pr create`.

### Phân vai Claude Code / Codex

Dự án dùng hai AI agent với vai trò tách biệt:

| Agent | Vai trò | File hướng dẫn |
| ----- | ------- | -------------- |
| **Claude Code** | **Implementer** — viết feature mới, command mới, service mới, tích hợp API, refactor lớn, thay đổi kiến trúc. | `CLAUDE.md` (file này) |
| **Codex** | **Reviewer** — review code, chỉ ra bug/edge case/lỗi bảo mật, đề xuất cải tiến, sửa lỗi nhỏ (typo/type), viết test. **KHÔNG viết feature mới.** | `AGENTS.md` |

**Nguyên tắc:**
- **Claude Code** chủ động build; sau khi xong, nhờ **Codex** review trước khi merge vào `main`.
- **Codex** chỉ đề xuất với thay đổi lớn — quyết định implement thuộc về Claude Code / người dùng.
- Khi cần thêm feature → giao Claude Code. Khi cần soát chất lượng → giao Codex.
- Chi tiết ràng buộc vai trò Codex → xem `AGENTS.md`.

### Other Conventions

- **Language**: Bot responses are Vietnamese-first (AI chat replies follow the user's language). `/start` & `/help` are Vietnamese.
- **Reply formatting**: In user-facing replies avoid em dashes (`—`) and don't wrap command tokens in double quotes (e.g. write `Gõ Theses`, not `Gõ "Theses"`). Quotes are kept only around dynamic user values (alias, task, keyword, ticker) for clarity.
- **Command menu**: Slash commands shown in Telegram's "/" menu are registered on startup via `bot.api.setMyCommands(BOT_COMMANDS)` (in `index.ts` `bot.start` `onStart`). The list (`/start`, `/help`, `/plan`, `/upgrade`) is separate from the in-chat `/help` text — update both when adding a slash command. Note `/plan` is routed inside the `message:text` handler (not via `bot.command`), yet its menu entry still works because Telegram just sends the literal text `/plan`.
- **Markdown handling**: AI responses have `*`, `#`, and `_` stripped/escaped before sending to Telegram (parsed as Markdown mode).
- **No tests**: No automated test suite. Only manual test scripts in `src/test-*.ts`.
- **Gitignore**: `node_modules/`, `dist/`, `.env`, `service_account.json`, and `data/` are gitignored.
- **Type safety**: `strict: true` in tsconfig, but some `@ts-ignore` and `any` casts exist (especially in AI service and Google service).

## Common Tasks

### Adding a new bot command
1. Add handler in `src/index.ts` — place it BEFORE the default AI chat fallback.
2. Use regex matching pattern consistent with existing commands.
3. Update the `/help` command text to document it.
4. If it's a slash command worth surfacing, add it to `BOT_COMMANDS` (the `setMyCommands` list) too.

### Adding/changing a DB table or column
1. Edit `src/db/schema.ts` (Drizzle `pgTable` definitions).
2. Push to Supabase: `npm run db:push` — ⚠️ tạm đổi `DATABASE_URL` sang session pooler port 5432 (xem chú ý ở Environment Variables), xong đổi lại 6543.
3. Update the corresponding service in `src/services/` (row ↔ item mapping if any).

### Adding a new Google API integration
1. Add scope in `GoogleService` constructor's `scopes` array.
2. Add method in `google.service.ts`.
3. Ensure Service Account has permissions on the target resource.

### Changing the AI model
- Two models, both set in `.env`: `AI_CHAT_MODEL` (smart chat / Q&A / weekly report / trade analytics, default `aws/claude-sonnet-4-6-medium`) and `AI_FAST_MODEL` (calendar extraction + daily digest, default `free/claude-haiku-4-5`). Read in `config.ts` as `chatModel` / `fastModel`.
- Uses Vertex-Key.com prefix format: `aws/claude-opus-4-7`, `aws/claude-sonnet-4-6-medium`, `free/claude-haiku-4-5`, `aws/qwen3-codex`, etc.
- ⚠️ Vertex-Key deprecated the tier-less `aws/claude-sonnet-4-6` id (returns 400 "no longer available — pick an explicit effort tier"). Sonnet must carry a tier (`-medium`/`-high`); Haiku is available under both `aws/` and the newer `free/` prefix.
- Change in `.env` — no code changes needed.

### Modifying user profile fields
1. Update `UserProfile` interface in `user.service.ts` **and** the `users` table in `src/db/schema.ts` (+ `npm run db:push`).
2. Add detection regex in `index.ts` message handler.
3. Call `aiService.refreshSession(userId)` after profile changes to rebuild system instruction.
