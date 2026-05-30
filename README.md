# 📓 EdgeBook

> **Capture your edge.** A trading research OS that lives right inside Telegram.

EdgeBook turns the chaos of forwarded alpha — Telegram channels, signal groups, on-chain alerts — into a searchable, auto-tagged research database, then hands it back to you as a daily digest and a trade journal. Zero-friction capture: forward a message, and EdgeBook does the rest.

## Why EdgeBook?

Traders already live on Telegram. Competitors (Notion, Obsidian, TradingView) force you to *leave* Telegram to save research. EdgeBook keeps you where the alpha flows — **1 tap to capture, with original context intact**.

## Features

- **Smart capture** — forward any message → auto-tag tickers (BTC, ETH…), classify category, score sentiment, save to Google Docs.
- **Search & filter** — `Search: <keyword>`, `Tag: <ticker>` across everything you've saved.
- **Daily Digest** — 08:00 AI summary grouped by ticker with sentiment.
- **Trade Journal** — log trades (`Trade: Long BTC entry 108k SL 105k TP 115k`), auto-compute PnL on close, track win rate & RR.
- **Ask AI** — `Ask: What did I save about BTC this week?`
- **Bookmarks, To-Do, Calendar** — the everyday glue.

## Plans

| | Free | Pro $9.99/mo | Premium $24.99/mo |
|---|---|---|---|
| Forwards/day | 10 | ∞ | ∞ |
| Search & Tag | — | ✅ | ✅ |
| Daily Digest | — | ✅ | ✅ |
| Trade Journal | — | ✅ | ✅ |
| Sentiment / Export | — | — | ✅ |

## Tech

TypeScript · [grammY](https://grammy.dev) · Vertex-Key.com (OpenAI-compatible AI) · Google APIs (Docs/Calendar/Drive) · LemonSqueezy (payments) · JSON file persistence.

## Quick start

```bash
npm install
cp .env.example .env   # fill TELEGRAM_BOT_TOKEN, VERTEX_KEY_API_KEY, etc.
npm run dev            # hot-reload via nodemon
npm run build && npm start   # production
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture and conventions, and [`PLAN.md`](./PLAN.md) for the product roadmap.
