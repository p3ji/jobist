import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../cloudflare/worker.mjs";
import { reserveAction, settleAction, releaseExpiredActions } from "../cloudflare/usage-ledger.mjs";

const site = "https://jobist.peji.ca";
const migrations = ["0001_monetization.sql", "0002_refund_ordering.sql"]
  .map(file => fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));

function localD1() {
  const sqlite = new DatabaseSync(":memory:");
  migrations.forEach(migration => sqlite.exec(migration));
  const wrap = (sql, args = []) => ({
    bind(...values) { return wrap(sql, values); },
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
    _run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
  });
  return {
    prepare: sql => wrap(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement => statement._run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    close() { sqlite.close(); },
  };
}

const api = (path, method = "GET", body, headers = {}) => new Request(`${site}${path}`, {
  method,
  headers: { ...(method !== "GET" ? { Origin: site, "Content-Type": "application/json" } : {}), ...headers },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

async function signedEvent(event, secret) {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)))].map(value => value.toString(16).padStart(2, "0")).join("");
  return api("/api/stripe/webhook", "POST", raw, { "Stripe-Signature": `t=${timestamp},v1=${signature}` });
}

test("sandbox sign-in and Checkout fulfill exactly one pass after a signed paid webhook", async () => {
  const originalFetch = globalThis.fetch;
  const DB = localD1();
  const env = {
    DB, BILLING_ENABLED: "true", CHECKOUT_TEST_ENABLED: "true", TURNSTILE_SITE_KEY: "test-site-key",
    TURNSTILE_SECRET_KEY: "test-secret", RESEND_API_KEY: "test-resend", AUTH_PEPPER: "test-pepper",
    AUTH_FROM_EMAIL: "login@jobist.peji.ca", STRIPE_SECRET_KEY: "sk_test_synthetic",
    STRIPE_TEST_PRICE_ID: "price_1UKisfDS4HQRiHjB9C5GgYJ0", STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
  };
  let code;
  let checkoutBody;
  globalThis.fetch = async (url, options) => {
    if (url.includes("siteverify")) return Response.json({ success: true, hostname: "jobist.peji.ca" });
    if (url.includes("api.resend.com")) {
      code = JSON.parse(options.body).html.match(/<strong>(\d{6})<\/strong>/)?.[1];
      return Response.json({ id: "email_test" });
    }
    if (url.includes("api.stripe.com")) {
      checkoutBody = new URLSearchParams(options.body);
      return Response.json({ id: "cs_test_synthetic12345", url: "https://checkout.stripe.com/c/pay/cs_test_synthetic12345" });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  };
  try {
    const send = await worker.fetch(api("/api/auth/request-code", "POST", { email: "TEST@example.com", turnstileToken: "challenge" }), env);
    assert.equal(send.status, 200);
    assert.match(code, /^\d{6}$/);
    const bad = await worker.fetch(api("/api/auth/verify-code", "POST", { email: "test@example.com", code: "000000" }), env);
    assert.equal(bad.status, 400);
    const verify = await worker.fetch(api("/api/auth/verify-code", "POST", { email: "test@example.com", code }), env);
    assert.equal(verify.status, 200);
    const cookie = verify.headers.get("Set-Cookie").split(";")[0];
    assert.match(verify.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Lax/);
    const authenticated = (path, method = "GET", body) => api(path, method, body, { Cookie: cookie });
    const initial = await (await worker.fetch(authenticated("/api/me/usage"), env)).json();
    assert.equal(initial.free[0].scans_remaining, 5);
    assert.equal(initial.free[0].packets_remaining, 5);

    const checkout = await worker.fetch(authenticated("/api/checkout/session", "POST", {}), env);
    assert.equal(checkout.status, 200);
    assert.equal((await checkout.json()).url, "https://checkout.stripe.com/c/pay/cs_test_synthetic12345");
    assert.equal(checkoutBody.get("mode"), "payment");
    assert.equal(checkoutBody.get("line_items[0][price]"), env.STRIPE_TEST_PRICE_ID);
    assert.equal(checkoutBody.get("line_items[0][quantity]"), "1");
    const orderId = checkoutBody.get("client_reference_id");
    assert.equal((await (await worker.fetch(authenticated("/api/me/usage"), env)).json()).passes.length, 0);
    assert.equal((await (await worker.fetch(authenticated("/api/checkout/status?session_id=cs_test_synthetic12345"), env)).json()).status, "pending");

    const paidSession = { id: "cs_test_synthetic12345", client_reference_id: orderId, mode: "payment", payment_status: "paid", amount_total: 1500, currency: "cad", payment_intent: "pi_test_synthetic" };
    const paid = { id: "evt_test_paid", livemode: false, type: "checkout.session.completed", data: { object: paidSession } };
    const forged = api("/api/stripe/webhook", "POST", JSON.stringify(paid), { "Stripe-Signature": "t=1,v1=bad" });
    assert.equal((await worker.fetch(forged, env)).status, 400);
    const webhook = await worker.fetch(await signedEvent(paid, env.STRIPE_WEBHOOK_SECRET), env);
    assert.equal(webhook.status, 200);
    assert.equal((await (await worker.fetch(authenticated("/api/checkout/status?session_id=cs_test_synthetic12345"), env)).json()).status, "paid");
    await worker.fetch(await signedEvent(paid, env.STRIPE_WEBHOOK_SECRET), env);
    await worker.fetch(await signedEvent({ ...paid, id: "evt_test_paid_again" }, env.STRIPE_WEBHOOK_SECRET), env);
    const active = await (await worker.fetch(authenticated("/api/me/usage"), env)).json();
    assert.equal(active.passes.length, 1);
    assert.equal(active.passes[0].scans_remaining, 30);
    assert.equal(active.passes[0].packets_remaining, 20);

    const refund = { id: "evt_test_refund", livemode: false, type: "charge.refunded", data: { object: { refunded: true, payment_intent: "pi_test_synthetic" } } };
    assert.equal((await worker.fetch(await signedEvent(refund, env.STRIPE_WEBHOOK_SECRET), env)).status, 200);
    assert.equal((await (await worker.fetch(authenticated("/api/me/usage"), env)).json()).passes.length, 0);
  } finally { globalThis.fetch = originalFetch; DB.close(); }
});

test("allowance reservations are idempotent and failed work restores the last credit once", async () => {
  const DB = localD1();
  try {
    await DB.prepare("INSERT INTO accounts(id,email,created_at) VALUES('a','a@example.com',1)").run();
    await DB.prepare(`INSERT INTO entitlements(id,account_id,kind,granted_at,scans_total,scans_remaining,packets_total,packets_remaining)
      VALUES('free','a','free',1,5,1,5,5)`).run();
    const input = { accountId: "a", kind: "scan", idempotencyKey: "11111111-1111-4111-8111-111111111111", inputDigest: "a".repeat(64), now: 10 };
    const first = await reserveAction(DB, input);
    assert.equal(first.status, "reserved");
    assert.equal((await reserveAction(DB, input)).id, first.id);
    assert.equal(await reserveAction(DB, { ...input, idempotencyKey: "22222222-2222-4222-8222-222222222222" }), null);
    assert.equal((await DB.prepare("SELECT scans_remaining FROM entitlements WHERE id='free'").first()).scans_remaining, 0);
    assert.equal((await settleAction(DB, { accountId: "a", actionId: first.id, outcome: "released", now: 20 })).status, "released");
    assert.equal(await settleAction(DB, { accountId: "a", actionId: first.id, outcome: "released", now: 21 }), null);
    assert.equal((await DB.prepare("SELECT scans_remaining FROM entitlements WHERE id='free'").first()).scans_remaining, 1);
    const second = await reserveAction(DB, { ...input, idempotencyKey: "22222222-2222-4222-8222-222222222222" });
    assert.equal(second.status, "reserved");
    await releaseExpiredActions(DB, 1000);
    assert.equal((await DB.prepare("SELECT scans_remaining FROM entitlements WHERE id='free'").first()).scans_remaining, 1);
  } finally { DB.close(); }
});

test("a refund delivered before payment prevents the pass from being granted", async () => {
  const DB = localD1();
  const env = { DB, BILLING_ENABLED: "true", STRIPE_WEBHOOK_SECRET: "whsec_synthetic" };
  try {
    await DB.prepare("INSERT INTO accounts(id,email,created_at) VALUES('account','refund@example.com',1)").run();
    await DB.prepare(`INSERT INTO orders(id,account_id,stripe_session_id,amount_cents,currency,status,created_at)
      VALUES('order','account','cs_test_refundfirst123',1500,'cad','pending',1)`).run();
    const refund = { id: "evt_refund_first", livemode: false, type: "charge.refunded", data: { object: { refunded: true, payment_intent: "pi_refund_first" } } };
    const paid = { id: "evt_paid_later", livemode: false, type: "checkout.session.completed", data: { object: {
      id: "cs_test_refundfirst123", client_reference_id: "order", mode: "payment", payment_status: "paid",
      amount_total: 1500, currency: "cad", payment_intent: "pi_refund_first",
    } } };
    assert.equal((await worker.fetch(await signedEvent(refund, env.STRIPE_WEBHOOK_SECRET), env)).status, 200);
    assert.equal((await worker.fetch(await signedEvent(paid, env.STRIPE_WEBHOOK_SECRET), env)).status, 200);
    assert.equal((await DB.prepare("SELECT status FROM orders WHERE id='order'").first()).status, "refunded");
    assert.equal((await DB.prepare("SELECT count(*) AS count FROM entitlements").first()).count, 0);
    assert.equal((await worker.fetch(await signedEvent({ ...paid, id: "evt_paid_retry" }, env.STRIPE_WEBHOOK_SECRET), env)).status, 200);
    assert.equal((await DB.prepare("SELECT count(*) AS count FROM entitlements").first()).count, 0);
  } finally { DB.close(); }
});
