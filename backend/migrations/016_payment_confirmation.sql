-- Migration: 016_payment_confirmation
-- Description: Add txHash, confirmedAt, and payment_records table

ALTER TABLE orders ADD COLUMN tx_hash TEXT;
ALTER TABLE orders ADD COLUMN confirmed_at DATETIME;
ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','confirmed','failed'));

CREATE TABLE IF NOT EXISTS payment_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER REFERENCES orders(id),
  intent_id    TEXT NOT NULL UNIQUE,
  amount       REAL NOT NULL,
  destination  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed')),
  tx_hash      TEXT,
  confirmed_at DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
