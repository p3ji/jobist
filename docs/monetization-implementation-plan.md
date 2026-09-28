# Monetization implementation handoff

Status: partially implemented; see [implementation progress](monetization-progress.md). This is not authorization to turn on live billing. Product decision: [monetization strategy](monetization-strategy.md). Prepared 2026-09-28 against the current repository. Implement the remaining gates in order and keep billing disabled until each launch check passes.

## 1. Product contract to implement

| Allowance | Free account, once | CA$15 one-time pass, valid 30 days from verified payment |
| --- | ---: | ---: |
| Job discovery scans | 5 | 30 |
| Application packets | 5 | 20 |

The pass does not renew. Each purchase creates a separate entitlement with its own expiry; when several passes are active, spend the earliest-expiring balance first. Free balances do not expire. Show both balances, pass expiry, and the exact action that will use an allowance. **All allowances apply only to Jobist-funded AI.** A supported bring-your-own-model connection never debits them and never requires a Jobist payment. Never auto-submit an application or send a message for the user.

**Scan accounting:** one `scan` starts when the user chooses experience-based or targeted discovery. It includes up to three search directions, supported portal requests, optional rerank, up to 15 quick AI matches in batches of four, and one “Refresh AI matches” attempt for that same scan. Reserve before the first upstream call. Commit one scan when at least one usable listing is shown, including partial portal success. Release it when all sources fail or return no listings. Limit empty/failed scans separately to prevent free repeated scraping. Opening a listing and revisiting a saved scan do not use another allowance.

**Packet accounting:** one `packet` is keyed to an account plus a canonical posting digest and confirmed profile version. Reserve before “Evaluate this job.” Commit when a valid full fit report is shown, regardless of whether the result recommends applying. That packet includes one AI résumé/cover-letter draft and its independent review for the same posting and profile version, even if drafting happens later. If the user stops after reading the fit report, the packet remains used; state this beside the Evaluate button. Failed evaluation releases the reservation. Failed drafting or review can be retried under that packet within a bounded retry policy and does not consume another packet. If the review fails and the initial draft is shown, label it as unreviewed and allow retry; do not present it as a completed independent review. A changed posting or confirmed profile requires a new packet. Reopening, editing, exporting, or saving completed work costs nothing.

**Other AI work:** profile extraction and the guided interview do not spend scans or packets. Give hosted extraction its own transparent abuse limits (proposed initial ceiling: 10 successful extractions/account/day, 3 concurrent or in-flight attempts/account); manual profile entry remains available. Example mode never touches paid services or balances. A user's own Gemini or Qwen API key and local LM Studio never use Jobist AI allowances, but hosted portal endpoints still need request and abuse limits. Preserve session-only personal keys.

The hosted account stores identity and entitlements. Candidate profiles, documents, job descriptions, fit reports, and drafts remain in browser workspace storage; do not silently sync them to D1. Explain that signing in on a second device restores balances but not the workspace. Preserve JSON export and complete local-data deletion. On the hosted site, personal-key users can run AI without a pass; require a signed-in account for portal scans and give those scans a separate per-account rate limit. Local Python/LM Studio needs no hosted account. After the five free Jobist-funded uses are exhausted, show **Use my own AI** alongside the pass offer, not as a hidden workaround.

## 2. Repository map and required refactor

| Current location | Work |
| --- | --- |
| `app.js` | Client workflow, browser state, current `callAi`, scan orchestration, fit/draft actions, local/BYOK path, UI balance display. Keep evidence checks and editable outputs. |
| `cloudflare/worker.mjs` | Hosted API routing, identity/session checks, usage reservations, stage policy, provider metering, Checkout and webhook. Remove public `envKeys` response. |
| `cloudflare/job-search.mjs` | Existing portal integration. Call only through a bounded, action-scoped scan stage for server-funded flows. |
| `server.py` | Keep the no-build local experience and local LM Studio behavior. Billing and hosted accounts should be Cloudflare-only; do not force Stripe or D1 into the local Python server. |
| `index.html`, `style.css` | Sign-in, allowance labels, pre-action notice, exhausted state, one-time Checkout, expiry, payment-pending message. Check 375px and WCAG 2.2 AA. |
| Worker Content Security Policy | Permit only the exact Turnstile script/frame origin needed for login; keep other external scripts blocked. Stripe Checkout is a full-page redirect. |
| `wrangler.toml`, new `migrations/` | D1 binding, secrets, feature flags, and schema migrations. Use separate test/staging/production resources. |
| `tests/worker.test.mjs`, browser tests | Add quota, retry, webhook, identity, privacy, and mobile/accessibility coverage. Update the current test that assumes an anonymous request can use the server Gemini key. |
| `scripts/build_hosted.py`, `dist/` | If new browser assets are introduced, update the copy list. Rebuild and commit `dist/` after browser edits. |

The current hosted `/api/ai` accepts any browser-supplied prompt, schema, and model and falls back to Jobist's server key. It cannot remain the server-funded route behind a paywall. A client-supplied `stage: "draft"` field would still be bypassable. Move hosted, server-funded prompts and fixed output schemas into trusted Worker modules. Accept only bounded structured inputs for `extract`, `plan`, `quick_match`, `fit`, `draft`, and `review`; run provider calls through those modules. Keep the existing client `callAi` for local/BYOK, but make `/api/ai` and `/api/gemini` **require an actual client key** on hosted requests and never fall back to the server key. Reject missing keys before provider work. Apply body, model, and rate limits to BYOK too. Do not expose the server key or provider billing metadata to the browser. Route a BYO request solely to the provider selected and verified for that tab; provider errors must never cause an automatic switch to Jobist-funded AI.

For server-funded stages, keep the client-side evidence validation and add server-side schema and bounded-input checks. Treat all posting content as untrusted data. A server-generated draft is not automatically a confirmed candidate fact.

### Bring your own model, free of Jobist charges

Implement a provider registry and adapter interface for `generate(prompt, schema, optionalFile)` with normalized output and error types. The registry can grow to other reviewed providers and models without changing allowance rules; it is not an arbitrary URL proxy. The first supported hosted adapters are personal-key Gemini (already present) and Alibaba Cloud Model Studio Qwen, starting with official model ID **`qwen3.8-27b`**. Alibaba lists that model and an [OpenAI-compatible Chat Completions interface](https://help.aliyun.com/en/model-studio/qwen3-8-27b). The local adapter remains LM Studio at `127.0.0.1:1234` when Jobist itself runs locally; [LM Studio documents the compatible endpoint](https://lmstudio.ai/docs/developer/openai-compat/structured-output). The UI should distinguish “Jobist AI (uses allowances),” “My Gemini API key,” “My Qwen API key,” and “Local model on this computer.” For personal-key routes, say “No Jobist charge; your provider may charge you.” For local models, say that they use the user's own computer.

For Qwen, offer a **region selector**, not a free-form URL field. Map each region to the fixed official Model Studio HTTPS endpoint in a server-side allowlist; Alibaba says [API keys and endpoints are region-specific](https://help.aliyun.com/en/model-studio/base-url). Send the personal key only in that request's authorization header, use `redirect: "manual"`, and never persist or log it. Validate the selected model ID against a Qwen allowlist. Before accepting a key, make a small connection check with no career data. Keep key and chosen model in tab memory only; clear the key input after connection and on tab close. Display the selected provider and region before transmitting résumé data. Do not accept arbitrary upstream URLs in this release; a future custom endpoint feature must meet the repository's DNS/redirect/SSRF rule first.

The Qwen3.8 open-source family supports [JSON-object output, but the published strict JSON-schema list does not include `qwen3.8-27b`](https://help.aliyun.com/en/model-studio/qwen-structured-output). Request JSON-object output, then parse and validate against Jobist's existing schemas and evidence checks. Permit one bounded format retry; return a clear error if still invalid. Do not silently switch models or spend a Jobist allowance. Test each workflow stage with this adapter. For uploaded PDF/Word files, support only formats demonstrated to work with the selected adapter or extract text in the browser before sending; always keep paste/manual profile entry available and explain a format limitation instead of invoking Jobist-funded Gemini.

The hosted BYO path has **no 5/5 paywall and no 30/20 pass requirement**. A signed-in BYO user can run portal discovery under fair-use source limits (initial proposal: 10 scans/day and 100 per rolling 30 days, adjusted after portal review), and can paste postings for fit/drafting without a Jobist allowance. Jobist may show a pass offer as an optional convenience, never as the only way forward. Continue applying account/network rate limits and content-size caps to the proxy. Do not count local or personal-key generations as provider costs paid by Jobist.

## 3. Gate A — measurement and privacy

Create a small pricing table in code, versioned by provider/model and effective date; never infer cost from user-selected model strings. On each provider response record the provider's input tokens, output tokens (including thinking where reported), status, model, workflow stage, action ID, price-table version, estimated cost in integer USD microdollars, and duration. Record retries as separate upstream attempts. If a provider omits usage, mark cost `unknown` and use a conservative ceiling for admission control. Cohere usage is counted in search units and remains disabled for commercial traffic until production pricing is verified.

Keep only metadata in telemetry. No CV text, posting text, AI prompt, model output, API key, authorization header, OTP, full IP address, or payment card details in logs/analytics. Use opaque account/action IDs. Restrict operator access and document retention and deletion behavior. The public `/api/ai/config` must expose only safe feature booleans and a fixed advertised model; remove `envKeys`. Keep errors free of private input excerpts.

Before deciding that CA$15 covers usage, collect at least 100 **completed** journeys and all their failures. Report median/p95/max cost and latency separately for extraction, scans, fit, drafting/review, and whole packets; include provider retries, Cohere, Worker requests, and email. Set configurable per-account daily ceilings, provider-stage token/output ceilings, max concurrent runs, and a global monthly spend kill switch. A ceiling breach must stop new server-funded work while allowing users to access saved results and their own-key/local paths. Use the provider's paid API tier for production data handling; Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) distinguishes free and paid data-use treatment.

**Gate A acceptance:** a synthetic journey yields a complete cost ledger; failures are visible without private payloads; `/api/ai/config` reveals no secret names; a disabled provider or exhausted global budget returns a specific recoverable error and makes no upstream call.

## 4. Gate B — identity and server-enforced allowances

### Identity

Use email one-time codes, not passwords or Google-only sign-in. Suggested implementation: Cloudflare Worker sends a six-digit code via [Resend's email API](https://resend.com/docs/api-reference/emails/send-email) from a verified Jobist domain; use a local test sender in development. Resend's current free plan lists 3,000 emails/month and 100/day, so monitor that limit and budget for growth. [Pricing](https://resend.com/pricing). Normalize email; store it only for account access and receipts. Store only a keyed hash of the OTP, expire it after 10 minutes, allow at most five verification attempts, and throttle sends per address and network. Return the same response for known and unknown addresses. Protect sign-in and purchase entry with [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) plus rate limits; offer an accessible recovery path if the challenge fails.

After OTP verification, issue a random, opaque session token in a `Secure; HttpOnly; SameSite=Lax` cookie with a bounded lifetime (proposed 14 days) and rotate it at sign-in. Store only its hash in D1. Require a valid session and same-origin/CSRF protection for state-changing account, credit, and Checkout routes. Log out by revoking the session. A new account gets one free entitlement exactly once; signing in again never resets it. Do not require an account to view the landing page, edit a profile manually, use example mode, or run local LM Studio.

### D1 schema and invariants

Create migrations for at least these tables; use integer timestamps in UTC and explicit uniqueness/foreign keys:

| Table | Minimum fields / constraints |
| --- | --- |
| `accounts` | `id` primary key, normalized email unique, created/deleted timestamps. |
| `auth_codes`, `sessions` | Account/address key, token hash, expiry, attempt count or revoked time. Never store raw tokens. |
| `entitlements` | `id`, account ID, `free` or `pass`, grant time, expiry nullable for free, total/remaining scan and packet counters, payment/order link. `CHECK` counters are nonnegative. Exactly one free entitlement per account. |
| `actions` | `id`, account ID, entitlement ID, kind (`scan`/`packet`), client idempotency key, request/profile/posting digest, status (`reserved`, `committed`, `released`), timestamps, bounded retry count; unique `(account_id, kind, idempotency_key)`. |
| `stage_attempts` | Action ID, fixed stage name, attempt number, provider/model, token/search units, estimated cost, status, timestamp. Store no prompt or result. |
| `orders` | Internal order ID, account ID, Stripe Checkout Session ID unique, PaymentIntent ID unique when available, amount/currency, status, created/paid/refunded times, entitlement ID. |
| `webhook_events` | Stripe event ID unique, event type, processed time and result; no full webhook payload. |

An action reservation and decrement must be one atomic D1 transaction; [D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) runs statements transactionally, but use conditional SQL/constraints so a zero-row debit cannot create a reservation. Prefer a conditional insert/trigger or a tested transactional pattern with a uniqueness check. Duplicate idempotency keys return the existing action and do not decrement twice. Releasing a reservation restores exactly one counter. Committing does not decrement again. Expired pass balances are not spendable, and a reservation must have a short lease (proposed 15 minutes) plus a recovery sweep. If a paid entitlement expires while a reserved action is in progress, let that action finish within its lease; do not start new ones. Use earliest-expiring eligible entitlement first. Compute profile/posting digests on the server from canonical bounded input using a keyed HMAC; do not trust a client-provided digest as authorization. Test two simultaneous last-credit requests against a real local D1 instance, not only mocked arrays.

The browser never supplies entitlement ID, remaining balance, price, provider key, or a trustworthy stage label. The server derives these from the session and action record. Show the balance from `GET /api/me/usage`, not from local storage. Use stable error codes such as `AUTH_REQUIRED`, `ALLOWANCE_EXHAUSTED`, `ACTION_EXPIRED`, `STAGE_LIMIT`, and `BUDGET_PAUSED`; return accessible human-readable text alongside each code. Initial input caps to enforce before upstream calls: 8 MiB per file, 40,000 profile characters, 20,000 posting characters, and 15 postings per quick-match scan; tune these against measured legitimate documents before launch.

### Hosted API contract

| Route | Purpose and minimum rule |
| --- | --- |
| `POST /api/auth/request-code`, `POST /api/auth/verify-code`, `POST /api/auth/logout` | Start/complete/revoke an email session. Rate limit and verify challenge on request-code. |
| `GET /api/me/usage` | Return available free/pass scans and packets with pass expiry, active actions, and billing-enabled flag. No candidate data. |
| `DELETE /api/me` | Reauthenticate, revoke sessions, delete identity and usage data where possible, and preserve only the minimal de-identified payment records required by the documented retention policy. Make the effect on unused passes explicit before deletion. |
| `POST /api/profile/extract` | Authenticated hosted server-key extraction using a fixed prompt/schema and its own daily limit; no scan or packet debit. BYOK stays on the personal-key route. |
| `POST /api/ai` | Personal-key Gemini or Qwen only on the hosted site. Require explicit `provider`, key, and allowlisted model/region; reject missing key and any request to use the Jobist key. Never debit allowances. |
| `POST /api/actions` | Body: `kind`, UUID `idempotencyKey`, bounded workflow inputs or their digests. Authenticate, reserve one allowance atomically, return opaque `actionId` and allowed stages. |
| `POST /api/actions/:id/stages/:stage` | Authenticate owner; validate action kind, fixed stage order, input limits, stage-specific call count, per-stage idempotency, and current budget before any portal/provider call. Return structured result and usage metadata stripped to what the UI needs. |
| `POST /api/actions/:id/complete` | Validate meaningful result server-side and commit or release according to the accounting rules. Do not trust a client `success: true` flag without checking recorded stage completion. |
| `GET /api/actions/:id` | Return status for refresh/recovery, no sensitive result body. |
| `POST /api/checkout/session` | Authenticated, server-chosen fixed price/currency only; creates one pending order and hosted Checkout Session. |
| `POST /api/stripe/webhook` | Verify Stripe signature over the **raw body**, then fulfill idempotently. No browser authentication; webhook secret is its credential. |

Stage contract for the server-funded path:

| Action/stage | Input from browser | Server-owned checks and output |
| --- | --- | --- |
| `scan/plan` | Confirmed profile snapshot and search preferences | Fixed directions prompt/schema; at most one provider call; return 2–3 bounded directions. Targeted scan skips this stage. |
| `scan/portal_search` | Targeted query or directions from the prior stage, location/language | Supported source allowlist; at most three directions, bounded queries and portal calls; record listing count; return normalized listings. |
| `scan/rerank` and `scan/quick_match` | Bounded candidate listings and the same profile snapshot | Optional one rerank; quick-match batches of four, at most 15 candidates/four calls; fixed evidence-grounded prompt and schema. Verify the profile digest against the action. |
| `packet/fit` | Confirmed profile and one job snapshot | Verify digests, fixed fit prompt/schema, server-side structural and claim checks; successful fit is the packet commit point. |
| `packet/draft`, `packet/review` | Same profile/job, validated fit, then initial draft | Verify digests, fixed prompt/schema, one draft and one review with bounded retries; mark review failure explicitly. |

Store only stage status, usage and small non-sensitive counts in D1; the browser holds result bodies. For scan completion, a recorded portal stage with `listing_count > 0` is sufficient even when matching is partial. For packet completion, the server-recorded, validated fit stage is sufficient; the client cannot directly mark a packet complete. Each stage request needs its own idempotency key and a replay limit. Return the same action ID for duplicate reservations and never create another debit while an action is in progress.

Keep scan stages bounded to one planning call (experience mode only), at most three directions × supported sources, at most eight detail fetches, one rerank, up to four quick-match calls, and one included refresh. A packet permits one full fit, one draft, and one review, with bounded recovery retries. A direct pasted posting skips scan stages. Provider models for server-funded calls come from a strict server allowlist and per-stage configuration. The current generic server-key path, raw `/api/jobs/scan`, `/api/jobs/detail`, and `/api/jobs/rerank` must be rejected for unauthenticated or non-action-scoped hosted calls; merely hiding buttons is insufficient. For hosted BYOK scans, use an authenticated `byok_scan` action that checks the same source limits but debits no Jobist AI allowance; never let a BYOK label select the server key.

Because browser-only workspace data is a product invariant, do not persist stage input or output in D1. The client saves returned results locally. On lost response, a same-action retry may repeat one upstream stage at Jobist's expense, within strict retry and spend caps; it never spends another user allowance. If that cap is reached, show a recoverable support path rather than charging a second packet. Do not claim cross-device recovery of candidate work.

**Gate B acceptance:** anonymous server-key requests and direct endpoint calls cannot reach Gemini, Cohere, or portals; the sixth successful Jobist-funded scan/packet is refused; simultaneous requests cannot overspend the last balance; failed and empty scans restore balance; a valid fit consumes one packet once; drafting retry under that packet does not consume another; expiry and replay rules match the table above. A user with zero Jobist allowances can still complete a pasted-posting fit and draft using a personal Qwen/Gemini key, and a locally running user can do so with LM Studio. A Qwen invalid-JSON response, wrong-region key, or provider outage must return a provider-specific error without falling back to Jobist AI or changing a balance. A Qwen request cannot be redirected to an arbitrary host; personal keys are absent from local storage, D1, logs, and returned errors.

## 5. Gate C — purchase and lifecycle

Stripe test setup is complete in sandbox account `acct_1UKii7DS4HQRiHjB`: [Jobist Pass test product](https://dashboard.stripe.com/acct_1UKii7DS4HQRiHjB/test/products/prod_VLPijqH8QBoip0), product ID `prod_VLPijqH8QBoip0`, and [default test Price](https://dashboard.stripe.com/acct_1UKii7DS4HQRiHjB/test/prices/price_1UKisfDS4HQRiHjB9C5GgYJ0), Price ID `price_1UKisfDS4HQRiHjB9C5GgYJ0`. Verified in the signed-in dashboard on 2026-09-28: **CAD 15.00, one-time, active/default**. The customer-visible description states 30 days, 30 job discovery scans, 20 application packets, and no renewal. Configure this Price ID in the non-secret staging binding when implementing Checkout. Create a separate live Price only at the live-billing release gate; never substitute a test Price in production. Checkout, webhook, tax, and live billing have not yet been configured.

Create a fixed CA$15 one-time Stripe Price and use a [hosted Checkout Session in `payment` mode](https://docs.stripe.com/api/checkout/sessions/create). The Worker chooses the Price ID, return URLs, account/order reference, and a server-generated Stripe idempotency key; the browser cannot choose amount or currency. The Checkout success page is **not** proof of payment. On return show “Payment processing” and refresh `/api/me/usage` until the webhook creates the entitlement or a clear delayed-payment state is shown.

Verify `Stripe-Signature` against the unmodified raw body before parsing; see [Stripe's signature guidance](https://docs.stripe.com/webhooks/signature). Fulfill `checkout.session.completed` only when `payment_status` is paid. If delayed payment methods are enabled, also handle `checkout.session.async_payment_succeeded` and failure; Stripe's [payment guidance](https://github.com/stripe/ai/blob/main/skills/stripe-best-practices/references/payments.md) calls out that distinction. Deduplicate by both event ID and Checkout Session/order ID so redelivery and out-of-order events cannot issue two passes. Reconcile the expected fixed Price, amount, currency, account, and mode before granting access. Handle refunds and chargebacks with an explicit policy: stop new use of the refunded pass while retaining already-created local work; never silently remove unrelated free or other purchased balances. Provide an operator-only, audited correction path for payment/provider failures.

Display: CA$15 before any applicable tax, the final payable total at Checkout, 30-day duration, 30 scans/20 packets, one-time/no auto-renew, current and post-purchase balances, expiry date/time, contact/refund link, and a receipt route through Stripe. Confirm tax and refund text with the operator before live checkout. Keep Stripe secret, webhook secret, and Price ID in environment bindings/secrets; separate test and live values. Stripe's [idempotency documentation](https://docs.stripe.com/api/idempotent_requests) should guide Checkout creation retries.

**Gate C acceptance:** test Checkout payment grants exactly one pass; canceled/unpaid session grants none; duplicate/reordered webhook events grant once; success URL without webhook grants none; delayed payment behaves correctly; refund disables only its own remaining allowance; purchased outputs remain editable after expiry. No live charge is required for automated tests.

## 6. Gate D — provider/source readiness

Maintain `docs/source-usage-review.md` with one row per Job Bank/Guichet-Emplois, Freehire, and Eluta source: official terms URL, access method, robots/API notes, commercial-use conclusion, request rate, caching/attribution rules, reviewer and review date. Until a source is approved for this use, disable it in paid hosted scans behind a source flag and keep direct posting intake available. This is a product launch check, not a claim that a source has approved Jobist.

Obtain Cohere production-key access and a written/current per-search price for the actual rerank model before enabling it on paid traffic. Cohere says [trial keys are not for production/commercial use](https://cohere.com/pricing). If it cannot be confirmed, leave rerank off and use the existing keyword fallback. Verify paid Gemini account, model availability, request limits, and provider privacy wording. Run evidence-grounding and bilingual evaluation before changing the current hosted `gemini-2.5-flash` default to the planned `gemini-3.5-flash-lite`; a price match alone does not justify a model change.

**Gate D acceptance:** every enabled paid source has a signed review row; production keys and prices are recorded without exposing secrets; source/model feature flags fail closed; the site still supports pasted jobs when all portal sources are disabled.

## 7. Gate E — pilot, rollout, and deployment

Introduce flags `BILLING_ENABLED=false`, `HOSTED_ALLOWANCES_ENFORCED=false` during development, plus independent provider/source kill switches. Turn on server-side authentication and metering for invited accounts in staging first. Use a small pilot of 10–20 invited users, then measured production exposure. Never have a mode where the UI says credits are enforced but public server-key routes remain available. Keep an operator rollback that stops new purchases and server-funded work without hiding saved local work.

Pilot dashboard, in aggregate only: activated accounts, completed free scans/packets, users reaching allowance limits, pass purchases/conversion, pass consumption and expiry, BYO model adoption and failure rate without keys or prompts, median/p95/max Jobist-paid cost and latency per action, 503/retry rate, empty scans, failed/credited actions, refunds, email delivery, support time, and accessibility issues. Set go/no-go thresholds **before** the pilot; do not invent a conversion target from competitor prices. Review the CA$15/30/20 offer after actual usage and qualitative feedback.

Required verification: `node --test tests/*.test.mjs`, `python3 -m unittest discover -s tests`, a local D1 concurrency test, Stripe CLI/test-mode webhook replay, and browser smoke at 375px with keyboard and screen reader review. Rebuild hosted assets with `python3 scripts/build_hosted.py`, check the `dist/` diff, and commit the generated files. Deployment to live `main` and turning on live billing are separate release steps. Do not put real provider or Stripe keys in fixtures, source, logs, or `dist/`.

## Work order for an implementing agent

1. Inventory current repo changes and preserve them. Record the shipped default model and all current AI/portal entry points. Implement Gate A and tests first.
2. Add D1 migrations, authentication, server-owned stage policy, entitlements, personal-key Qwen adapter, and the new client calls. Close public server-key bypasses in the same release that turns on enforcement. Complete Gate B and BYO tests before Checkout work.
3. Add Stripe test-mode Checkout, webhook, and purchase UI. Complete Gate C tests without enabling live billing.
4. Complete source/provider review, update disclosure and terms text, and run the invited pilot. Implement only reviewed provider/source switches.
5. Report measured cost, failures, remaining risks, and a concrete go/no-go recommendation. Ask for final approval only when the live price, tax/refund copy, and release are reviewable.

The implementing agent should update this document when a decision changes, rather than silently changing the user-facing 5/5 and 30/20 contract.
