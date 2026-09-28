-- Remember full refunds even when Stripe delivers the refund before the paid session.
CREATE TABLE IF NOT EXISTS refunded_payment_intents (
  payment_intent_id TEXT PRIMARY KEY,
  refunded_at INTEGER NOT NULL
);
