// Internal-only allowance functions. Never expose settlement to an untrusted client flag.
const LEASE_SECONDS = 15 * 60;

export async function reserveAction(db, { accountId, kind, idempotencyKey, inputDigest, now = Math.floor(Date.now() / 1000) }) {
  if (!accountId || !["scan", "packet"].includes(kind) || !/^[0-9a-f-]{36}$/i.test(idempotencyKey) || !/^[0-9a-f]{64}$/.test(inputDigest))
    throw new TypeError("Invalid action reservation");
  const previous = await db.prepare("SELECT id,input_digest,status FROM actions WHERE account_id=? AND kind=? AND idempotency_key=?")
    .bind(accountId, kind, idempotencyKey).first();
  if (previous) {
    if (previous.input_digest !== inputDigest) throw new Error("Idempotency key belongs to different input");
    return { id: previous.id, status: previous.status, reused: true };
  }
  const column = kind === "scan" ? "scans_remaining" : "packets_remaining";
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO actions(id,account_id,entitlement_id,kind,idempotency_key,input_digest,status,reserved_at,lease_expires_at)
    SELECT ?,account_id,id,?,?,?,'reserved',?,? FROM entitlements
    WHERE account_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND ${column}>0
    ORDER BY expires_at IS NULL,expires_at LIMIT 1 ON CONFLICT(account_id,kind,idempotency_key) DO NOTHING`)
    .bind(id, kind, idempotencyKey, inputDigest, now, now + LEASE_SECONDS, accountId, now).run();
  if (!result.meta?.changes) {
    const raced = await db.prepare("SELECT id,input_digest,status FROM actions WHERE account_id=? AND kind=? AND idempotency_key=?")
      .bind(accountId, kind, idempotencyKey).first();
    if (raced) {
      if (raced.input_digest !== inputDigest) throw new Error("Idempotency key belongs to different input");
      return { id: raced.id, status: raced.status, reused: true };
    }
    return null;
  }
  return { id, status: "reserved", reused: false };
}

export async function settleAction(db, { accountId, actionId, outcome, now = Math.floor(Date.now() / 1000) }) {
  if (!accountId || !actionId || !["committed", "released"].includes(outcome)) throw new TypeError("Invalid action settlement");
  const result = await db.prepare(`UPDATE actions SET status=?,completed_at=?
    WHERE id=? AND account_id=? AND status='reserved' AND lease_expires_at>=?`)
    .bind(outcome, now, actionId, accountId, now).run();
  if (!result.meta?.changes) return null;
  return { id: actionId, status: outcome };
}

export async function releaseExpiredActions(db, now = Math.floor(Date.now() / 1000)) {
  // The release trigger restores each balance exactly once.
  return db.prepare("UPDATE actions SET status='released',completed_at=? WHERE status='reserved' AND lease_expires_at<?")
    .bind(now, now).run();
}
