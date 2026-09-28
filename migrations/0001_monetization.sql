PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('free', 'pass')),
  order_id TEXT UNIQUE,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  scans_total INTEGER NOT NULL CHECK (scans_total >= 0),
  scans_remaining INTEGER NOT NULL CHECK (scans_remaining BETWEEN 0 AND scans_total),
  packets_total INTEGER NOT NULL CHECK (packets_total >= 0),
  packets_remaining INTEGER NOT NULL CHECK (packets_remaining BETWEEN 0 AND packets_total),
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_free_entitlement_per_account ON entitlements(account_id) WHERE kind = 'free';
CREATE INDEX IF NOT EXISTS spendable_entitlements ON entitlements(account_id, expires_at);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id),
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'packet')),
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  reserved_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(account_id, kind, idempotency_key)
);

CREATE TRIGGER IF NOT EXISTS reserve_scan AFTER INSERT ON actions
WHEN NEW.kind = 'scan'
BEGIN
  UPDATE entitlements SET scans_remaining=scans_remaining-1
    WHERE id=NEW.entitlement_id AND scans_remaining>0 AND revoked_at IS NULL;
  SELECT RAISE(ABORT, 'scan allowance unavailable') WHERE changes()=0;
END;

CREATE TRIGGER IF NOT EXISTS reserve_packet AFTER INSERT ON actions
WHEN NEW.kind = 'packet'
BEGIN
  UPDATE entitlements SET packets_remaining=packets_remaining-1
    WHERE id=NEW.entitlement_id AND packets_remaining>0 AND revoked_at IS NULL;
  SELECT RAISE(ABORT, 'packet allowance unavailable') WHERE changes()=0;
END;

CREATE TRIGGER IF NOT EXISTS release_scan AFTER UPDATE OF status ON actions
WHEN OLD.status='reserved' AND NEW.status='released' AND NEW.kind='scan'
BEGIN
  UPDATE entitlements SET scans_remaining=scans_remaining+1 WHERE id=NEW.entitlement_id;
END;

CREATE TRIGGER IF NOT EXISTS release_packet AFTER UPDATE OF status ON actions
WHEN OLD.status='reserved' AND NEW.status='released' AND NEW.kind='packet'
BEGIN
  UPDATE entitlements SET packets_remaining=packets_remaining+1 WHERE id=NEW.entitlement_id;
END;

CREATE TABLE IF NOT EXISTS stage_attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_micro_usd INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(action_id, stage, attempt)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  stripe_session_id TEXT UNIQUE,
  payment_intent_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents = 1500),
  currency TEXT NOT NULL CHECK (currency = 'cad'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  refunded_at INTEGER,
  entitlement_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  result TEXT NOT NULL
);
