-- Sprint 8 schema delta — additive only, safe to run on the live DB.
-- Apply via the SESSION pooler (port 5432), e.g. in the Supabase SQL editor,
-- or `npm run db:push` with DATABASE_URL pointed at :5432.

-- Trade Journal 2.0: risk-based fields on existing trades (all nullable)
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "position_size" real;
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "risk_percent" real;
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "fee_percent" real;
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "close_reason" text;   -- 'tp' | 'sl' | 'manual'
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "setup_tag" text;

-- Price Alerts
CREATE TABLE IF NOT EXISTS "alerts" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" bigint NOT NULL,
    "ticker" text NOT NULL,
    "condition" text NOT NULL,            -- 'above' | 'below'
    "target_price" real NOT NULL,
    "status" text NOT NULL,               -- 'active' | 'triggered'
    "created_at" timestamp with time zone NOT NULL,
    "triggered_at" timestamp with time zone
);

-- Watchlist
CREATE TABLE IF NOT EXISTS "watchlist_items" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" bigint NOT NULL,
    "ticker" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "watchlist_user_ticker_idx"
    ON "watchlist_items" USING btree ("user_id", "ticker");
