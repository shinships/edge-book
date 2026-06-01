# CLAUDE.md — Project Guide for AI Assistants

> **Brand: EdgeBook** — *"capture your edge."* A trading research OS that lives in Telegram.
> (Formerly "Bot Forward Docs"; npm package `edgebook`.)

## Project Overview

**EdgeBook** is a **Telegram Bot** that acts as a personal AI assistant and **Research OS for traders/investors**. Integrates **AI chat via Vertex-Key.com** (OpenAI-compatible API), **Google Docs** for saving notes/images, **Google Calendar** for scheduling, a local **To-Do list**, and a **smart research management system** with auto-tagging, search, digest, and subscription tiers. Built with **TypeScript**, uses the **grammY** framework for Telegram Bot API.

## Tech Stack

| Layer        | Technology                                    |
| ------------ | --------------------------------------------- |
| Runtime      | Node.js + TypeScript (ES2022, CommonJS)       |
| Bot Framework| grammY v1.20                                  |
| AI           | Vertex-Key.com (`openai` SDK) via OpenAI-compatible API — chat `AI_CHAT_MODEL` (default `aws/claude-sonnet-4-6`), fast `AI_FAST_MODEL` (default `aws/claude-haiku-4-5`) |
| Google APIs  | `googleapis` (Calendar v3, Drive v3, Docs v1) |
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
├── SHOPEE_PLAN.md              # Shopee tracker feature notes
├── data/
│   ├── users.json              # Persisted user profiles & doc aliases
│   ├── todos.json              # Persisted to-do items (created at runtime)
│   ├── research.json           # Research items with tags, sentiment (created at runtime)
│   ├── plans.json              # User subscription plans (created at runtime)
│   └── trades.json             # Trade Journal entries per user (created at runtime)
├── src/
│   ├── config.ts               # Loads env vars, validates required keys
│   ├── index.ts                # Entry point — bot commands, message handlers, cron jobs
│   ├── webhook.server.ts       # Express HTTP server for LemonSqueezy payment webhooks
│   ├── services/
│   │   ├── ai.service.ts       # AI chat, calendar analysis, digest generation, research Q&A
│   │   ├── google.service.ts   # Calendar, Drive, Docs API wrappers
│   │   ├── payment.service.ts  # LemonSqueezy checkout creation, HMAC verify, upgrade logic
│   │   ├── plan.service.ts     # Subscription tier tracking & feature gating
│   │   ├── report.service.ts   # PDF trade report generation via pdfkit (Premium export)
│   │   ├── research.service.ts # Research items: auto-tagging, search, star, digest data
│   │   ├── shopee.service.ts   # Shopee price tracker & flash sale notifier
│   │   ├── thesis.service.ts   # Thesis tracker: record theses + conflict detection vs research sentiment (Premium)
│   │   ├── todo.service.ts     # File-based to-do CRUD per user
│   │   ├── trade.service.ts    # Trade Journal: open/close trades, PnL calc, stats, analytics (Pro/Premium)
│   │   └── user.service.ts     # File-based user profile management & doc aliases
│   ├── utils/                  # (empty — reserved for future utilities)
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

# Manual tests
npx ts-node src/test-ai.ts
npx ts-node src/test-calendar.ts
npx ts-node src/test-drive.ts
```

## Environment Variables (`.env`)

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | ✅       | Telegram Bot API token                   |
| `VERTEX_KEY_API_KEY`          | ✅       | API key from vertex-key.com              |
| `VERTEX_KEY_BASE_URL`         | Optional | API base URL (default: `https://vertex-key.com/api/v1`) |
| `AI_CHAT_MODEL`               | Optional | Chat model ID (default: `aws/claude-sonnet-4-6`) |
| `AI_FAST_MODEL`               | Optional | Fast model ID (default: `aws/claude-haiku-4-5`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | ✅    | Path to Service Account JSON file        |
| `GOOGLE_DOC_ID`               | Optional | Default Google Doc ID for saving content |
| `GOOGLE_DRIVE_FOLDER_ID`      | Optional | Drive folder for photo uploads           |
| `LEMONSQUEEZY_API_KEY`        | Optional | LS API key — required to enable `/upgrade` |
| `LEMONSQUEEZY_STORE_ID`       | Optional | LS Store ID                              |
| `LEMONSQUEEZY_PRO_VARIANT_ID` | Optional | LS Variant ID for Pro plan               |
| `LEMONSQUEEZY_PREMIUM_VARIANT_ID` | Optional | LS Variant ID for Premium plan       |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Optional | Webhook signing secret for HMAC verify   |
| `WEBHOOK_PORT`                | Optional | Port for webhook Express server (default: `3000`) |
| `ADMIN_USER_IDS`              | Optional | Comma-separated Telegram user IDs treated as admins (always Premium access) |

Both `TELEGRAM_BOT_TOKEN` and `VERTEX_KEY_API_KEY` are validated on startup — app exits if missing.
LemonSqueezy keys are optional; if absent, the `/upgrade` command shows a "not configured" message.

## Architecture & Key Patterns

### Message Flow (index.ts)

All logic is in `bot.on('message:text')` and `bot.on('message:photo')` handlers in `index.ts`. Message routing uses **regex matching + keyword detection** in this priority order:

1. **Doc management**: `Add Doc <alias> <id>`, `Use Doc <alias>`, `Current Doc`
2. **To-Do List**: Quick task management via `Add Task: [content]` and `List Tasks`.
   - **Shopee Tracker**: Monitor prices and get alerted before Flash Sales. Commands:
   - `Track Shopee <link>` or `Theo dõi <link>`
   - `/shopee` or `shopee list`
   - `Untrack Shopee <index>`
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
4. **Trade Journal commands** (new, Pro):
   - `Trade: <Long|Short> <ticker> entry <price> SL <price> TP <price>` — open a trade (regex-parsed, `k` suffix supported)
   - `Close: <ticker> <price>` or `Close: <ticker> +3.2%` — close most-recent open trade, auto-computes PnL%
   - `Trades` / `My Trades` — list open + recent closed trades (shows 🔗N link tag)
   - `Trade Stats` — win rate, total PnL, avg planned RR, best/worst
   - `Trade Analytics` / `Performance` (Premium) — breakdown by ticker/direction/month + avg hold + AI insight
   - `Export` / `Export PDF` (Premium) — generates a PDF trade report (summary, monthly bar chart, ticker/direction breakdown, trade log) via `ReportService` and sends it as a Telegram document
5. **Calendar**: Messages containing "schedule", "meeting", or "remind" → AI extracts event data → Calendar API
6. **Personalization**: `Call me <name>`, `My name is <name>`, `My job is <job>`, `Remember: <note>`
7. **Save to Docs + Research**: `Save: <content>` command OR forwarded messages → auto-tags tickers, classifies category, scores sentiment, saves to Research DB + appends to active Google Doc. For Premium users, also runs `ThesisService.findConflicts()` and sends a conflict alert if the new item contradicts an active thesis.
8. **Default**: Falls through to AI chat with per-user session

### Photo Handler

Photos are saved to Google Docs when:
- Caption contains "save" keyword, OR
- Message is forwarded from another chat

Reacts with ❤ emoji on success (falls back to text reply if reactions aren't supported).

### Service Layer

- **AIService**: Uses OpenAI SDK (`openai` package) with Vertex-Key.com as base URL. Manages per-user conversation history (messages array) with personalized system instructions. History is in-memory (Map, max 50 messages), not persisted. Post-processes responses to strip markdown formatting (bold, headers) and escape underscores. Also provides `generateDigest()`, `generateWeeklyReport()` (top tickers + sentiment shift) and `askAboutResearch()` for the Research OS, plus `generateTradeInsight()` for trade analytics.
- **GoogleService**: Thin wrappers around Google APIs. Uses Service Account auth. Calendar defaults to `Asia/Ho_Chi_Minh` timezone.
- **ResearchService** *(new)*: File-based persistence to `data/research.json`. Manages research items with auto-tagging (tickers via regex), category classification (keyword-based), sentiment scoring (rule-based), search (by keyword/ticker/category), star/bookmark, digest data aggregation, and weekly-report data (`getWeeklyReportData` — this-week vs last-week activity + per-ticker sentiment shift).
- **PlanService** *(new)*: File-based persistence to `data/plans.json`. Manages subscription tiers (free/pro/premium), daily forward rate limiting, feature gating, and plan expiration. Accepts an admin-ID list (from `config.adminUserIds` / `ADMIN_USER_IDS`); admins are always treated as Premium (`isAdmin()`, `effectiveTier()` → all feature gates pass, unlimited forwards, always digest-eligible).
- **UserService**: File-based persistence to `data/users.json`. Supports multi-doc aliases (e.g., `work` → `<docId>`). Auto-sets first added doc as active.
- **TodoService**: File-based persistence to `data/todos.json`. Supports completion by index (1-based) or keyword search.
- **TradeService** *(new)*: File-based persistence to `data/trades.json`. Manages the Trade Journal — open/close trades, auto-computes PnL% (price- or percent-based, direction-aware), and aggregates stats (win rate, total PnL, avg planned RR, best/worst). Pro-gated via `canTrade`. Also supports **research-to-trade link** (`linkResearch`/`getTradeById`, `linkedResearch: string[]` on each trade) — Premium-gated via `canLinkResearch`. On `Close:`, Premium users get an inline keyboard of recent research matching the ticker (callback `linkres:<tradeId>:<researchId>`); the `Trades` list shows a 🔗N tag for trades with links. Also provides **advanced analytics** (`getAnalytics` → breakdown by ticker/direction/month + avg hold duration over closed trades) — Premium-gated via `canAnalytics`, surfaced by the `Trade Analytics` command with an AI insight from `AIService.generateTradeInsight`.
- **ThesisService** *(new)*: File-based persistence to `data/theses.json`. Records per-user theses (`ticker`, `stance` bullish/bearish, `text`) and detects contradictions: `findConflicts(userId, ticker, sentiment)` returns active theses whose stance is clearly opposed to a newly-saved research item's sentiment (±0.2 threshold) and bumps their `conflictCount`. Wired into the Save/forward flow in `index.ts`; Premium-gated via `canThesis`. Detection is rule-based (no AI call on the save hot path).
- **ReportService** *(new)*: Generates a trade performance **PDF** with `pdfkit` (in-memory `Buffer`, sent via grammY `InputFile`). Renders a header banner, summary, a drawn monthly-PnL bar chart, by-ticker/by-direction tables, and a closed-trade log with multi-page support (`bufferPages: true` for the footer pass). PDF text is **ASCII/English** — pdfkit's built-in fonts can't render Vietnamese diacritics, so `index.ts` runs the trader name through a `toAscii()` helper. Premium-gated via `canExport`.

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
| Max Docs | 1 | 5 | Unlimited |

### Cron Jobs

**Daily Digest** — a `node-cron` job runs at **08:00 daily (Asia/Ho_Chi_Minh)** that:
1. Gathers research items from the last 24 hours per user
2. Groups by ticker, calculates sentiment
3. Generates AI-powered summary via `AIService.generateDigest()`
4. Sends formatted digest to each eligible user via Telegram
5. Checks and downgrades expired subscription plans

**Weekly Report** — a `node-cron` job runs at **18:00 every Sunday (Asia/Ho_Chi_Minh)** that, for each digest-eligible (Pro/Premium) user with research in the last 7 days, builds `getWeeklyReportData()` and sends an AI report (`AIService.generateWeeklyReport()`) highlighting per-ticker sentiment shift vs the previous week.

### Data Persistence

All data is stored as JSON files in `data/`. Read on service init, written synchronously on every mutation. **No database.**

> ⚠️ This means concurrent writes from multiple bot instances could corrupt data. Run only one instance.

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

- **Language**: Bot responses mix English and Vietnamese (error messages in Vietnamese in `ai.service.ts`).
- **Markdown handling**: AI responses have `*`, `#`, and `_` stripped/escaped before sending to Telegram (parsed as Markdown mode).
- **No tests**: No automated test suite. Only manual test scripts in `src/test-*.ts`.
- **Gitignore**: `node_modules/`, `dist/`, `.env`, `service_account.json`, and `data/` are gitignored.
- **Type safety**: `strict: true` in tsconfig, but some `@ts-ignore` and `any` casts exist (especially in AI service and Google service).

## Common Tasks

### Adding a new bot command
1. Add handler in `src/index.ts` — place it BEFORE the default AI chat fallback.
2. Use regex matching pattern consistent with existing commands.
3. Update the `/help` command text to document it.

### Adding a new Google API integration
1. Add scope in `GoogleService` constructor's `scopes` array.
2. Add method in `google.service.ts`.
3. Ensure Service Account has permissions on the target resource.

### Changing the AI model
- Two models, both set in `.env`: `AI_CHAT_MODEL` (smart chat / digests / Q&A, default `aws/claude-sonnet-4-6`) and `AI_FAST_MODEL` (fast extraction tasks, default `aws/claude-haiku-4-5`). Read in `config.ts` as `chatModel` / `fastModel`.
- Uses Vertex-Key.com prefix format: `aws/claude-opus-4-7`, `aws/claude-sonnet-4-6`, `aws/qwen3-codex`, etc.
- Change in `.env` — no code changes needed.

### Modifying user profile fields
1. Update `UserProfile` interface in `user.service.ts`.
2. Add detection regex in `index.ts` message handler.
3. Call `aiService.refreshSession(userId)` after profile changes to rebuild system instruction.
