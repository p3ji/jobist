# Monetization implementation progress

Updated 2026-09-28. This records code already present and what still blocks a real paid pilot.

## Implemented in this checkout

- Stripe sandbox product `prod_VLPijqH8QBoip0` and one-time CAD 15 Price `price_1UKisfDS4HQRiHjB9C5GgYJ0` are verified. The Price ID is in `wrangler.toml` as a non-secret test binding.
- Hosted personal-key Qwen3.8-27B is wired into the existing AI workflow. It uses only fixed Singapore or Beijing Model Studio endpoints, rejects redirects, validates returned JSON, and never falls back to Jobist's key. Its key stays in tab memory. Qwen document uploads are explicitly unsupported until input extraction is reviewed; paste and manual entry remain available. Local LM Studio continues to support a locally loaded Qwen model.
- Public `/api/ai/config` no longer lists environment binding names. `MONETIZATION_ENFORCED=true` closes the generic server-key AI fallback and raw portal/rerank routes. This flag remains **false** because trusted, metered stages do not exist yet.
- `migrations/0001_monetization.sql` defines accounts, one-time codes, hashed sessions, entitlements, actions, stage attempts, orders, and webhook event IDs. SQL triggers debit on action insertion and restore balances on the first release. `cloudflare/usage-ledger.mjs` provides internal reservation, settlement, and expired-lease release functions. An isolated Cloudflare D1 database, `jobist-billing-test` (`82305e4c-a157-4343-af0e-f4f411019c50`), is bound only in `wrangler.billing-test.toml`; the migration was applied remotely on 2026-09-28. Two concurrent remote reservations against the final scan produced exactly one action and a zero balance. Releasing it twice restored exactly one scan. This database is not bound to the live Jobist Worker.
- `cloudflare/monetization.mjs` contains disabled-by-default test account and Checkout routes: Turnstile-protected email code request through Resend, code verification, hashed HttpOnly sessions, usage view, logout, server-priced Stripe Checkout, raw-body webhook signature verification, idempotent pass grant, failed asynchronous payment, and refund revocation. Migration `0002_refund_ordering.sql` records full refunds by payment intent so a refund delivered before its paid-session event cannot activate a pass. It accepts only Stripe **test** secret keys for Checkout. A hidden-until-enabled account dialog includes sign-in, balances, test Checkout, and webhook-confirmed payment status. `BILLING_ENABLED=false` and the separate `CHECKOUT_TEST_ENABLED=false` by default; the purchase button stays hidden unless both are explicitly enabled.

## Required before enabling either flag

1. Build trusted server-owned `extract`, `scan`, `fit`, `draft`, and `review` stages; connect the internal ledger with server-controlled completion evidence, bounded retries, and server-enforced 5/5 and 30/20 balances. Close every direct portal and server-key bypass while retaining personal-key and local paths. Current generic Gemini calls and raw hosted portal calls are still unmetered while the flag is false.
2. Deploy an isolated staging Worker with test-only credentials and replay real Stripe test events against it. Review the auth, Checkout, and refund code against real Stripe test events, including out-of-order refund and payment events. Keep the flags off on the live Worker until those tests pass.
3. Configure a verified Resend sending domain, Turnstile site/secret keys, a random `AUTH_PEPPER`, a Stripe `sk_test_` secret, and a `whsec_` webhook secret. Store secrets only as Worker secrets. Validate the new sign-in and purchase UI with the configured services, including keyboard/screen-reader review. Add network rate limits, support/refund links, and account/data deletion.
4. Finish provider usage/cost telemetry, spend ceilings, reviewed source access, production Cohere pricing, user copy, tax/refund policy, and a measured pilot. Create a separate live Stripe Price only at the live release gate.

The current test-mode Stripe product is a catalog item, not a sellable Jobist flow. Do not enable `BILLING_ENABLED` or `MONETIZATION_ENFORCED` on the hosted site from this checkout.

## Verification completed on 2026-09-28

- The full Node suite passed 33 tests and the Python suite passed 21. The hosted asset build and `git diff --check` also passed. The Node suite includes simulated sign-in, Checkout, paid webhook, duplicate event, refund before payment, and ledger lifecycle against both migration files.
- Wrangler applied `0001_monetization.sql` and `0002_refund_ordering.sql` to the isolated remote D1 database and reported success. The remote last-credit race and repeated release behaved as described above. Synthetic account `ledger-test-20260928` uses a non-deliverable `invalid.example` address; it is retained in the test database for inspection.
- At 375px in the local browser, the account dialog showed the free 5/5 balance and test pass offer without horizontal overflow. Its purchase and sign-out buttons were 49px tall; Escape closed the dialog and returned focus to Account. The view used a local fixture, not live billing services.
- No Worker was deployed and no live or test purchase was made during these checks. The Stripe event path still needs a configured staging Worker and real test-mode webhook replay.
