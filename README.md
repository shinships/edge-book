# 📓 EdgeBook

> **Capture your edge.** A trading research OS that lives right inside Telegram.

EdgeBook turns the chaos of forwarded alpha — Telegram channels, signal groups, on-chain alerts — into a searchable, auto-tagged research database, then hands it back to you as a daily digest, a trade journal, and real-time smart-money signals. Zero-friction capture: forward a message, and EdgeBook does the rest.

> bot: [@edgebook_bot](https://t.me/edgebook_bot) · npm: `edgebook`

## Why EdgeBook?

Traders already live on Telegram. Competitors (Notion, Obsidian, TradingView) force you to *leave* Telegram to save research. EdgeBook keeps you where the alpha flows — **1 tap to capture, with original context intact**.

## Features

- **Smart capture** — forward any message → auto-tag tickers (BTC, ETH, HPG…), classify category, score sentiment, save to Google Docs.
- **Research OS** — `Search:` / `Tag:` across everything; **Daily Digest** (08:00) & **Weekly Report** (Sun 18:00); `Ask:` AI over your saved notes; thesis tracker with conflict alerts.
- **Trade Journal** — log trades (`Trade: Long HPG entry 25 SL 23 TP 30`), auto-compute PnL on close, win rate & RR stats, advanced analytics + **PDF export**.
- **Discipline & Psychology OS** — 15s safety gate + pre-trade checklist, emotion/heart-rate scoring, auto risk-cut & lockout after a losing streak, end-of-day "perfect trader" audit.
- **Market & Alerts** — live prices (crypto: Binance · VN stocks: VNDirect), watchlist, price alerts.
- **VN smart money** 🇻🇳 — foreign & proprietary (tự doanh) net-flow alerts with threshold + session-streak, EOD technical alerts (volume/RSI/MA-cross), a daily **Smart-Money Digest**, insider-filing tracking (`Insider:`), **Point & Figure** charts rendered to PNG (`PnF:`), and a **VN30 Screener** (`Screener:`). Data from CafeF + VNDirect, no API key.
- **Subscriptions** — Free / Pro / Premium, paid via LemonSqueezy (international cards) or SePay VietQR (VN bank transfer).

## Plans

| | Free | Pro $9.99/mo | Premium $24.99/mo |
|---|---|---|---|
| Forwards/day | 10 | ∞ | ∞ |
| Search · Tag · Daily Digest · Weekly Report | — | ✅ | ✅ |
| Trade Journal | — | ✅ | ✅ |
| Watchlist | 3 | ∞ | ∞ |
| Price Alerts | — | 10 | ∞ |
| VN Alerts · Smart-Money Digest · P&F · Insider · Screener | — | ✅ | ✅ |
| Portfolio | — | ✅ | ✅ |
| Research↔Trade link · Analytics · Thesis · Sentiment · Export PDF | — | — | ✅ |
| Max Docs | 1 | 5 | ∞ |

> Telegram IDs in `ADMIN_USER_IDS` are always treated as Premium.

## Tech

TypeScript · [grammY](https://grammy.dev) · **PostgreSQL (Supabase)** via Drizzle ORM · Vertex-Key.com (OpenAI-compatible AI) · Google APIs (Docs/Calendar/Drive) · Binance + VNDirect + CafeF market data (no keys) · `@napi-rs/canvas` (P&F → PNG) · `pdfkit` (reports) · LemonSqueezy + SePay (payments).

## Quick start

```bash
npm install
cp .env.example .env          # fill TELEGRAM_BOT_TOKEN, VERTEX_KEY_API_KEY, DATABASE_URL, …
# place service_account.json (Google SA key) in the project root
npm run db:push               # push schema to Supabase (use session pooler port 5432)
npm run dev                   # hot-reload via nodemon
npm run build && npm start    # production
```

### Required env vars

`TELEGRAM_BOT_TOKEN`, `VERTEX_KEY_API_KEY`, `DATABASE_URL`, `GOOGLE_APPLICATION_CREDENTIALS` are validated on startup (the app exits if missing). LemonSqueezy / SePay / Google-Doc IDs are optional. See [`CLAUDE.md`](./CLAUDE.md) for the full table.

> `.env`, `service_account.json`, `data/`, `dist/`, `node_modules/` are gitignored — never commit.

## In-chat commands (sample)

```
Add Doc work <docId> · Use Doc work · List Docs · Current Doc
Save: <note>          Search: HPG    Tag: HPG    Digest
Trade: Long HPG entry 25 SL 23 TP 30     Close: HPG 28     Trades
Watch: HPG            Watchlist          Alert: BTC > 70k
Alert: HPG foreign buy 50 3p             Alert: HPG insider
Insider: HPG          PnF: HPG           Screener: oversold
/start · /help · /plan · /upgrade · /invite
```

## Deployment

- **Production**: Railway (manual `railway up`).
- **Windows Service**: run in background + on boot via `node-windows` (`npm run service:install`, elevated shell).
- ⚠️ **Single instance only** — Telegram long-polling allows one `getUpdates` consumer; don't run a manual bot and the service at the same time (409 Conflict).

## Docs

[`CLAUDE.md`](./CLAUDE.md) — architecture & conventions (most detailed) · [`PLAN.md`](./PLAN.md) — product roadmap · [`GTM.md`](./GTM.md) — growth · [`AGENTS.md`](./AGENTS.md) — reviewer agent role.

---

*EdgeBook — capture your edge.*
