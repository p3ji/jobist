// Test-mode account and Checkout foundation. Live billing is deliberately unsupported.
const PRICE_CENTS = 1500;
const PASS_SECONDS = 30 * 24 * 60 * 60;
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const enc = new TextEncoder();

function response(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", ...extraHeaders,
  } });
}
function error(status, code, message) { return response(status, { code, error: message }); }
function bytesHex(bytes) { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function randomToken() { return bytesHex(crypto.getRandomValues(new Uint8Array(32))); }
async function sha(value) { return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))); }
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesHex(new Uint8Array(await crypto.subtle.sign("HMAC", imported, enc.encode(value))));
}
function equalHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
async function secret(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value : typeof value?.get === "function" ? await value.get() : "";
}
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}
async function bodyJson(request, max = 4096) {
  const raw = await request.text();
  if (enc.encode(raw).length > max) throw new Error("too large");
  return JSON.parse(raw);
}
async function account(request, db) {
  const cookie = request.headers.get("Cookie")?.match(/(?:^|;\s*)jobist_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!cookie) return null;
  return db.prepare(`SELECT a.id, a.email FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND a.deleted_at IS NULL`)
    .bind(await sha(cookie), Math.floor(Date.now() / 1000)).first();
}
async function verifyTurnstile(token, env, request) {
  const key = await secret(env, "TURNSTILE_SECRET_KEY");
  if (!key || typeof token !== "string" || !token) return false;
  const form = new URLSearchParams({ secret: key, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(10000) });
  const result = await res.json();
  return Boolean(result?.success && result.hostname === new URL(request.url).hostname);
}

async function requestCode(request, env, db) {
  let input;
  try { input = await bodyJson(request); } catch { return error(400, "INVALID_INPUT", "Enter a valid email address."); }
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "INVALID_INPUT", "Enter a valid email address.");
  if (!await verifyTurnstile(input.turnstileToken, env, request)) return error(400, "CHALLENGE_FAILED", "The sign-in check failed. Please try again.");
  const now = Math.floor(Date.now() / 1000);
  const prior = await db.prepare("SELECT sent_at FROM auth_codes WHERE email=?").bind(email).first();
  if (prior?.sent_at > now - 60) return response(200, { sent: true });
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const pepper = await secret(env, "AUTH_PEPPER");
  const resend = await secret(env, "RESEND_API_KEY");
  if (!pepper || !resend || !env.AUTH_FROM_EMAIL) return error(503, "AUTH_UNAVAILABLE", "Sign-in is not configured yet.");
  const delivery = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.AUTH_FROM_EMAIL, to: [email], subject: "Your Jobist sign-in code", html: `<p>Your Jobist code is <strong>${code}</strong>. It expires in 10 minutes.</p>` }),
    signal: AbortSignal.timeout(10000),
  });
  if (!delivery.ok) return error(503, "EMAIL_UNAVAILABLE", "We could not send a sign-in code. Please try again later.");
  await db.prepare(`INSERT INTO auth_codes(email,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at`)
    .bind(email, await hmac(pepper, `${email}:${code}`), now + 600, 0, now).run();
  return response(200, { sent: true });
}

async function verifyCode(request, env, db) {
  let input;
  try { input = await bodyJson(request); } catch { return error(400, "INVALID_CODE", "The code is invalid or expired."); }
  const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  const code = typeof input?.code === "string" ? input.code.trim() : "";
  if (email.length > 254 || !/^\d{6}$/.test(code)) return error(400, "INVALID_CODE", "The code is invalid or expired.");
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT code_hash,expires_at,attempts FROM auth_codes WHERE email=?").bind(email).first();
  if (!row || row.expires_at <= now || row.attempts >= 5) return error(400, "INVALID_CODE", "The code is invalid or expired.");
  const attempt = await db.prepare("UPDATE auth_codes SET attempts=attempts+1 WHERE email=? AND attempts<5 AND expires_at>?").bind(email, now).run();
  if (!attempt.meta?.changes) return error(400, "INVALID_CODE", "The code is invalid or expired.");
  const pepper = await secret(env, "AUTH_PEPPER");
  if (!pepper || !equalHex(row.code_hash, await hmac(pepper, `${email}:${code}`))) return error(400, "INVALID_CODE", "The code is invalid or expired.");
  const id = crypto.randomUUID();
  const token = randomToken();
  await db.batch([
    db.prepare("INSERT INTO accounts(id,email,created_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING").bind(id, email, now),
    db.prepare(`INSERT INTO entitlements(id,account_id,kind,granted_at,scans_total,scans_remaining,packets_total,packets_remaining)
      SELECT ?,id,'free',?,5,5,5,5 FROM accounts WHERE email=? ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), now, email),
    db.prepare("INSERT INTO sessions(token_hash,account_id,expires_at) SELECT ?,id,? FROM accounts WHERE email=?").bind(await sha(token), now + SESSION_SECONDS, email),
    db.prepare("DELETE FROM auth_codes WHERE email=?").bind(email),
  ]);
  return response(200, { signedIn: true }, { "Set-Cookie": `jobist_session=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax` });
}

async function usage(db, accountId) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db.prepare(`SELECT kind,scans_remaining,packets_remaining,expires_at FROM entitlements
    WHERE account_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY expires_at IS NULL,expires_at`).bind(accountId, now).all();
  return { free: results.filter(item => item.kind === "free"), passes: results.filter(item => item.kind === "pass"), billingEnabled: true };
}

async function checkout(request, env, db, user) {
  if (env?.CHECKOUT_TEST_ENABLED !== "true") return error(503, "CHECKOUT_DISABLED", "Test Checkout is not available yet.");
  const stripeKey = await secret(env, "STRIPE_SECRET_KEY");
  if (!stripeKey?.startsWith("sk_test_") || !env.STRIPE_TEST_PRICE_ID?.startsWith("price_")) return error(503, "CHECKOUT_UNAVAILABLE", "Test Checkout is not configured yet.");
  const now = Math.floor(Date.now() / 1000);
  const pending = await db.prepare("SELECT id FROM orders WHERE account_id=? AND status='pending' AND created_at>? ORDER BY created_at DESC LIMIT 1").bind(user.id, now - 24 * 60 * 60).first();
  const orderId = pending?.id || crypto.randomUUID();
  if (!pending) await db.prepare("INSERT INTO orders(id,account_id,amount_cents,currency,status,created_at) VALUES(?,?,1500,'cad','pending',?)").bind(orderId, user.id, now).run();
  const origin = new URL(request.url).origin;
  const form = new URLSearchParams({
    mode: "payment", "line_items[0][price]": env.STRIPE_TEST_PRICE_ID, "line_items[0][quantity]": "1",
    client_reference_id: orderId, "metadata[order_id]": orderId,
    success_url: `${origin}/?checkout=processing&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}/?checkout=canceled`,
    customer_email: user.email,
  });
  const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST", headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `jobist-order-${orderId}` },
    body: form, signal: AbortSignal.timeout(15000),
  });
  const data = await stripe.json();
  if (!stripe.ok || !data?.id?.startsWith("cs_test_") || typeof data.url !== "string") {
    return error(502, "CHECKOUT_FAILED", "Stripe Checkout could not start. Please try again.");
  }
  await db.prepare("UPDATE orders SET stripe_session_id=? WHERE id=? AND status='pending'").bind(data.id, orderId).run();
  return response(200, { url: data.url });
}

export async function verifyStripeSignature(raw, header, signingSecret, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries((header || "").split(",").map(item => item.trim().split("=", 2)));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > 300 || !signingSecret?.startsWith("whsec_")) return false;
  const expected = await hmac(signingSecret, `${timestamp}.${raw}`);
  return (header || "").split(",").map(item => item.trim()).filter(item => item.startsWith("v1=")).some(item => equalHex(item.slice(3), expected));
}

async function webhook(request, env, db) {
  const raw = await request.text();
  if (enc.encode(raw).length > 1_000_000) return error(413, "TOO_LARGE", "Webhook too large.");
  if (!await verifyStripeSignature(raw, request.headers.get("Stripe-Signature"), await secret(env, "STRIPE_WEBHOOK_SECRET")))
    return error(400, "INVALID_SIGNATURE", "Invalid webhook signature.");
  let event;
  try { event = JSON.parse(raw); } catch { return error(400, "INVALID_EVENT", "Invalid webhook event."); }
  if (!event?.id?.startsWith("evt_") || typeof event.type !== "string" || event.livemode !== false) return error(400, "INVALID_EVENT", "Invalid test webhook event.");
  const now = Math.floor(Date.now() / 1000);
  const session = event.data?.object;
  const paid = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type);
  if (paid) {
    const orderId = session?.client_reference_id;
    const order = await db.prepare("SELECT id,account_id,status FROM orders WHERE id=? AND stripe_session_id=?").bind(orderId || "", session?.id || "").first();
    if (!order || session.mode !== "payment" || session.payment_status !== "paid" || session.amount_total !== PRICE_CENTS || session.currency !== "cad" || !/^pi_[A-Za-z0-9_]+$/.test(session.payment_intent || ""))
      return error(400, "ORDER_MISMATCH", "Checkout did not match a payable Jobist order.");
    const entitlementId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO webhook_events(stripe_event_id,event_type,processed_at,result) VALUES(?,?,?,'paid') ON CONFLICT DO NOTHING").bind(event.id, event.type, now),
      db.prepare(`UPDATE orders SET
        status=CASE WHEN EXISTS(SELECT 1 FROM refunded_payment_intents WHERE payment_intent_id=?) THEN 'refunded' ELSE 'paid' END,
        paid_at=?, refunded_at=(SELECT refunded_at FROM refunded_payment_intents WHERE payment_intent_id=?), payment_intent_id=?
        WHERE id=? AND status='pending'`).bind(session.payment_intent || "", now, session.payment_intent || "", session.payment_intent || null, order.id),
      db.prepare(`INSERT INTO entitlements(id,account_id,kind,order_id,granted_at,expires_at,scans_total,scans_remaining,packets_total,packets_remaining)
        SELECT ?,account_id,'pass',id,?,?,30,30,20,20 FROM orders WHERE id=? AND status='paid' ON CONFLICT DO NOTHING`)
        .bind(entitlementId, now, now + PASS_SECONDS, order.id),
      db.prepare("UPDATE orders SET entitlement_id=(SELECT id FROM entitlements WHERE order_id=?) WHERE id=? AND status='paid'").bind(order.id, order.id),
    ]);
  } else if (event.type === "checkout.session.async_payment_failed") {
    await db.batch([
      db.prepare("INSERT INTO webhook_events(stripe_event_id,event_type,processed_at,result) VALUES(?,?,?,'failed') ON CONFLICT DO NOTHING").bind(event.id, event.type, now),
      db.prepare("UPDATE orders SET status='failed' WHERE id=? AND stripe_session_id=? AND status='pending'").bind(session?.client_reference_id || "", session?.id || ""),
    ]);
  } else if (event.type === "charge.refunded" && session?.refunded === true && typeof session.payment_intent === "string") {
    await db.batch([
      db.prepare("INSERT INTO webhook_events(stripe_event_id,event_type,processed_at,result) VALUES(?,?,?,'refunded') ON CONFLICT DO NOTHING").bind(event.id, event.type, now),
      db.prepare("INSERT INTO refunded_payment_intents(payment_intent_id,refunded_at) VALUES(?,?) ON CONFLICT DO NOTHING").bind(session.payment_intent, now),
      db.prepare("UPDATE orders SET status='refunded',refunded_at=? WHERE payment_intent_id=? AND status='paid'").bind(now, session.payment_intent),
      db.prepare(`UPDATE entitlements SET revoked_at=? WHERE order_id IN
        (SELECT id FROM orders WHERE payment_intent_id=? AND status='refunded') AND revoked_at IS NULL`).bind(now, session.payment_intent),
    ]);
  } else {
    await db.prepare("INSERT INTO webhook_events(stripe_event_id,event_type,processed_at,result) VALUES(?,?,?,'ignored') ON CONFLICT DO NOTHING").bind(event.id, event.type, now).run();
  }
  return response(200, { received: true });
}

export async function handleMonetization(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (env?.BILLING_ENABLED !== "true") return error(503, "BILLING_DISABLED", "Jobist account and billing setup is not available yet.");
  if (!env.DB) return error(503, "DATABASE_UNAVAILABLE", "Jobist account storage is not configured yet.");
  if (request.method === "POST" && path === "/api/stripe/webhook") return webhook(request, env, env.DB);
  if (request.method !== "GET" && !sameOrigin(request)) return error(403, "ORIGIN_REQUIRED", "Request must come from Jobist.");
  if (request.method === "POST" && path === "/api/auth/request-code") return requestCode(request, env, env.DB);
  if (request.method === "POST" && path === "/api/auth/verify-code") return verifyCode(request, env, env.DB);
  const user = await account(request, env.DB);
  if (!user) return error(401, "AUTH_REQUIRED", "Sign in to your Jobist account.");
  if (request.method === "GET" && path === "/api/me/usage") return response(200, await usage(env.DB, user.id));
  if (request.method === "GET" && path === "/api/checkout/status") {
    const sessionId = url.searchParams.get("session_id") || "";
    if (!/^cs_test_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return error(400, "INVALID_SESSION", "Invalid Checkout session.");
    const order = await env.DB.prepare("SELECT status FROM orders WHERE account_id=? AND stripe_session_id=?").bind(user.id, sessionId).first();
    return order ? response(200, { status: order.status }) : error(404, "ORDER_NOT_FOUND", "Checkout session was not found for this account.");
  }
  if (request.method === "POST" && path === "/api/auth/logout") {
    const token = request.headers.get("Cookie")?.match(/(?:^|;\s*)jobist_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (token) await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=?").bind(Math.floor(Date.now() / 1000), await sha(token)).run();
    return response(200, { signedOut: true }, { "Set-Cookie": "jobist_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
  }
  if (request.method === "POST" && path === "/api/checkout/session") return checkout(request, env, env.DB, user);
  return error(404, "NOT_FOUND", "Not found.");
}
